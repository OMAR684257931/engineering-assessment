import { randomUUID } from "node:crypto";
import { notificationPayloadSchema } from "@assessment/contracts";
import type { PrismaClient } from "@assessment/database";
import type { NotificationSender } from "./notification-provider.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface BatchResult {
  found: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

/** A failed job stops being retried once it has had this many attempts. */
export const MAX_ATTEMPTS = 5;

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BATCH_SIZE = 20;

/**
 * How long a claim is honoured before another worker may take the job back.
 *
 * A claim is a lease, not a lock, because a worker can die mid-delivery and
 * would otherwise hold the job forever. The lease must comfortably exceed the
 * time one delivery can take (the provider call plus its own timeouts); 30s is
 * roughly two orders of magnitude above the mock provider's 75ms, which leaves
 * room for a slow real provider without leaving genuinely abandoned work
 * stranded for long.
 *
 * The trade-off is explicit: a delivery that outlives the lease can be picked
 * up a second time. That is why the provider call carries an idempotency key.
 */
export const CLAIM_LEASE_MS = 30_000;

export interface ProcessOptions {
  /** Identifies this worker in the claim, so concurrent workers do not collide. */
  workerId?: string;
  /** Injectable clock. Keeps retry/backoff tests deterministic. */
  now?: () => Date;
}

/**
 * Exponential backoff: 1s, 2s, 4s, 8s ... capped.
 * `attempt` is the number of attempts already made.
 */
export function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Delivers pending notification jobs.
 *
 * A job is only marked processed when the provider actually accepted it. A
 * failure schedules a bounded retry; once attempts are exhausted the job is
 * dead-lettered so an operator can inspect and replay it, rather than being
 * silently dropped (docs/DOMAIN.md).
 */
export async function processNotificationBatch(
  database: PrismaClient,
  sender: NotificationSender,
  logger: WorkerLogger = console,
  options: ProcessOptions = {},
): Promise<BatchResult> {
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? randomUUID();
  const startedAt = now();

  // A job is available when nobody holds a live lease on it: either it was
  // never claimed, or the previous claim has expired because that worker died
  // or stalled. Without the expiry check a crashed worker would hold the job
  // forever; without the claim check a slow worker's job would be delivered
  // twice.
  const leaseExpiredBefore = new Date(startedAt.getTime() - CLAIM_LEASE_MS);

  const candidates = await database.notificationJob.findMany({
    where: {
      processedAt: null,
      deadLetteredAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: startedAt } }],
      AND: [
        {
          OR: [
            { claimedAt: null },
            { claimedAt: { lt: leaseExpiredBefore } },
          ],
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  let found = 0;
  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const candidate of candidates) {
    // Take the lease before doing any work. The conditional update is atomic
    // and re-checks the same availability rule as the query above, so if
    // another worker claimed the job in between, this matches zero rows and we
    // skip it.
    const claim = await database.notificationJob.updateMany({
      where: {
        id: candidate.id,
        processedAt: null,
        deadLetteredAt: null,
        OR: [{ claimedAt: null }, { claimedAt: { lt: leaseExpiredBefore } }],
      },
      data: { claimedAt: startedAt, claimedBy: workerId },
    });

    if (claim.count === 0) continue;

    found += 1;
    const attempt = candidate.attemptCount + 1;

    try {
      const application = await database.loanApplication.findUnique({
        where: { id: candidate.applicationId },
        include: { customer: true },
      });

      if (!application) {
        throw new Error(
          `application ${candidate.applicationId} no longer exists`,
        );
      }

      // Parsed against the shared contract so a malformed or drifted payload
      // is a handled failure rather than an exception that escapes the batch.
      const payload = notificationPayloadSchema.parse(
        JSON.parse(candidate.payload),
      );

      await sender.sendStatusUpdate({
        idempotencyKey: candidate.sourceEventId,
        recipient: application.customer.email,
        customerName: application.customer.name,
        applicationId: application.id,
        status: payload.status,
        reason: payload.reason,
      });

      await database.notificationJob.update({
        where: { id: candidate.id },
        data: {
          attemptCount: attempt,
          processedAt: now(),
          lastError: null,
          // Clear the retry schedule and release the lease, so a delivered job
          // carries no leftover state from earlier failed attempts.
          nextAttemptAt: null,
          claimedAt: null,
          claimedBy: null,
        },
      });

      delivered += 1;
      logger.info(`notification job ${candidate.id} delivered`);
    } catch (error) {
      const lastError =
        error instanceof Error ? error.message : "unknown error";
      const exhausted = attempt >= MAX_ATTEMPTS;

      try {
        await database.notificationJob.update({
          where: { id: candidate.id },
          data: {
            attemptCount: attempt,
            lastError,
            // Left unprocessed so it stays eligible for retry.
            nextAttemptAt: exhausted
              ? null
              : new Date(now().getTime() + backoffMs(attempt)),
            deadLetteredAt: exhausted ? now() : null,
            claimedAt: null,
            claimedBy: null,
          },
        });
      } catch (bookkeepingError) {
        // Recording the failure itself failed. Log and move on: one bad row
        // must not abort the rest of the batch or terminate the worker.
        logger.error(
          `notification job ${candidate.id} could not be updated: ${
            bookkeepingError instanceof Error
              ? bookkeepingError.message
              : "unknown error"
          }`,
        );
      }

      if (exhausted) {
        deadLettered += 1;
        logger.error(
          `notification job ${candidate.id} dead-lettered after ${attempt} attempts: ${lastError}`,
        );
      } else {
        failed += 1;
        logger.error(
          `notification job ${candidate.id} failed (attempt ${attempt}): ${lastError}`,
        );
      }
    }
  }

  return { found, delivered, failed, deadLettered };
}
