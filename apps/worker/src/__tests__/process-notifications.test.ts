import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockEmailProvider,
  type NotificationSender,
} from "../notification-provider.js";
import {
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
  processNotificationBatch,
} from "../process-notifications.js";

const silentLogger = { info: vi.fn(), error: vi.fn() };

/** A sender that always fails, standing in for an unavailable provider. */
function failingSender(message = "provider unavailable"): NotificationSender {
  return { sendStatusUpdate: vi.fn().mockRejectedValue(new Error(message)) };
}

async function resetJobs() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-worker",
      name: "Worker Test",
      email: "worker@example.test",
      phone: "+201222222222",
      applications: {
        create: {
          id: "application-worker",
          status: "IN_REVIEW",
          requestedAmountCents: 50_000_00,
          notificationJobs: {
            create: {
              id: randomUUID(),
              sourceEventId: "worker-event-1",
              type: "APPLICATION_STATUS_CHANGED",
              payload: JSON.stringify({ status: "IN_REVIEW" }),
            },
          },
        },
      },
    },
  });
}

describe("notification worker", () => {
  beforeEach(resetJobs);

  it("delivers a pending status notification", async () => {
    const sender: NotificationSender = {
      sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const result = await processNotificationBatch(prisma, sender, {
      info: vi.fn(),
      error: vi.fn(),
    });

    expect(result).toEqual({
      found: 1,
      delivered: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(sender.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "worker-event-1",
        recipient: "worker@example.test",
      }),
    );

    const storedJob = await prisma.notificationJob.findFirstOrThrow();
    expect(storedJob.processedAt).toBeInstanceOf(Date);
    expect(storedJob.attemptCount).toBe(1);
  });

  describe("dependency failure", () => {
    it("keeps a failed job eligible and schedules a retry", async () => {
      const now = new Date("2026-08-25T10:00:00.000Z");
      const result = await processNotificationBatch(
        prisma,
        failingSender(),
        silentLogger,
        { now: () => now },
      );

      expect(result).toEqual({
        found: 1,
        delivered: 0,
        failed: 1,
        deadLettered: 0,
      });

      const job = await prisma.notificationJob.findFirstOrThrow();
      // The job must NOT be consumed: it is still pending work.
      expect(job.processedAt).toBeNull();
      expect(job.deadLetteredAt).toBeNull();
      expect(job.attemptCount).toBe(1);
      expect(job.lastError).toContain("provider unavailable");
      expect(job.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
      // The claim is released so another poll can pick it up.
      expect(job.claimedAt).toBeNull();
    });

    it("does not retry before the backoff has elapsed", async () => {
      const failAt = new Date("2026-08-25T10:00:00.000Z");
      await processNotificationBatch(prisma, failingSender(), silentLogger, {
        now: () => failAt,
      });

      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const tooSoon = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { now: () => new Date(failAt.getTime() + 1) },
      );

      expect(tooSoon.found).toBe(0);
      expect(sender.sendStatusUpdate).not.toHaveBeenCalled();
    });

    it("delivers on a later attempt once the provider recovers", async () => {
      const failAt = new Date("2026-08-25T10:00:00.000Z");
      await processNotificationBatch(prisma, failingSender(), silentLogger, {
        now: () => failAt,
      });

      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const recovered = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { now: () => new Date(failAt.getTime() + 60_000) },
      );

      expect(recovered).toEqual({
        found: 1,
        delivered: 1,
        failed: 0,
        deadLettered: 0,
      });
      expect(sender.sendStatusUpdate).toHaveBeenCalledTimes(1);

      const job = await prisma.notificationJob.findFirstOrThrow();
      expect(job.processedAt).toBeInstanceOf(Date);
      expect(job.attemptCount).toBe(2);
      expect(job.lastError).toBeNull();
    });

    it("dead-letters a job once attempts are exhausted", async () => {
      const sender = failingSender();
      let clock = new Date("2026-08-25T10:00:00.000Z");

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        await processNotificationBatch(prisma, sender, silentLogger, {
          now: () => clock,
        });
        // Advance past any scheduled backoff.
        clock = new Date(clock.getTime() + 10 * 60_000);
      }

      const job = await prisma.notificationJob.findFirstOrThrow();
      expect(job.attemptCount).toBe(MAX_ATTEMPTS);
      expect(job.deadLetteredAt).toBeInstanceOf(Date);
      expect(job.processedAt).toBeNull();
      expect(sender.sendStatusUpdate).toHaveBeenCalledTimes(MAX_ATTEMPTS);

      // A dead-lettered job is no longer picked up, but remains inspectable.
      const afterwards = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { now: () => clock },
      );
      expect(afterwards.found).toBe(0);
      expect(sender.sendStatusUpdate).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    it("isolates a poison payload instead of failing the batch", async () => {
      await prisma.notificationJob.updateMany({
        data: { payload: "not json at all" },
      });

      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const result = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { now: () => new Date("2026-08-25T10:00:00.000Z") },
      );

      expect(result.found).toBe(1);
      expect(result.failed).toBe(1);
      expect(sender.sendStatusUpdate).not.toHaveBeenCalled();

      const job = await prisma.notificationJob.findFirstOrThrow();
      expect(job.processedAt).toBeNull();
      expect(job.attemptCount).toBe(1);
    });
  });

  describe("concurrency and repeated execution", () => {
    it("delivers once when two workers poll at the same time", async () => {
      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const now = new Date("2026-08-25T10:00:00.000Z");

      const [a, b] = await Promise.all([
        processNotificationBatch(prisma, sender, silentLogger, {
          workerId: "worker-a",
          now: () => now,
        }),
        processNotificationBatch(prisma, sender, silentLogger, {
          workerId: "worker-b",
          now: () => now,
        }),
      ]);

      // Exactly one worker may claim the job.
      expect(a.found + b.found).toBe(1);
      expect(a.delivered + b.delivered).toBe(1);
      expect(sender.sendStatusUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not let a second worker take a job that is still being delivered", async () => {
      // The previous test lets both workers finish instantly, so it cannot
      // detect a worker taking over a delivery that is still in flight. Here
      // worker A is held inside the provider call until we release it, and
      // worker B polls during that window.
      let releaseA: () => void = () => {};
      const aIsDelivering = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      let aEnteredDelivery: () => void = () => {};
      const aHasStarted = new Promise<void>((resolve) => {
        aEnteredDelivery = resolve;
      });

      const slowSender: NotificationSender = {
        sendStatusUpdate: vi.fn().mockImplementation(async () => {
          aEnteredDelivery();
          await aIsDelivering;
        }),
      };
      const fastSender = {
        sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
      };

      const now = new Date("2026-08-25T10:00:00.000Z");

      const workerA = processNotificationBatch(
        prisma,
        slowSender,
        silentLogger,
        { workerId: "worker-a", now: () => now },
      );

      // Only poll once A is provably inside the provider call.
      await aHasStarted;

      const claimed = await prisma.notificationJob.findFirstOrThrow();
      expect(claimed.claimedBy).toBe("worker-a");
      expect(claimed.claimedAt).toBeInstanceOf(Date);

      const workerB = await processNotificationBatch(
        prisma,
        fastSender,
        silentLogger,
        { workerId: "worker-b", now: () => now },
      );

      // B must not take the job while A's lease is live.
      expect(workerB).toEqual({
        found: 0,
        delivered: 0,
        failed: 0,
        deadLettered: 0,
      });
      expect(fastSender.sendStatusUpdate).not.toHaveBeenCalled();

      releaseA();
      const resultA = await workerA;

      expect(resultA.delivered).toBe(1);
      expect(slowSender.sendStatusUpdate).toHaveBeenCalledTimes(1);

      const job = await prisma.notificationJob.findFirstOrThrow();
      expect(job.processedAt).toBeInstanceOf(Date);
      // One delivery means one attempt: no lost update from a second worker.
      expect(job.attemptCount).toBe(1);
      expect(job.claimedAt).toBeNull();
      expect(job.claimedBy).toBeNull();
    });

    it("recovers a job whose worker died holding the lease", async () => {
      const now = new Date("2026-08-25T10:00:00.000Z");
      // A worker claimed this job and never came back.
      await prisma.notificationJob.updateMany({
        data: {
          claimedAt: new Date(now.getTime() - CLAIM_LEASE_MS - 1_000),
          claimedBy: "worker-that-died",
        },
      });

      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const result = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { workerId: "worker-fresh", now: () => now },
      );

      // An expired lease must not strand the job forever.
      expect(result.delivered).toBe(1);
      expect(sender.sendStatusUpdate).toHaveBeenCalledTimes(1);

      const job = await prisma.notificationJob.findFirstOrThrow();
      expect(job.processedAt).toBeInstanceOf(Date);
      expect(job.claimedAt).toBeNull();
    });

    it("still protects a job whose lease has not yet expired", async () => {
      const now = new Date("2026-08-25T10:00:00.000Z");
      await prisma.notificationJob.updateMany({
        data: {
          claimedAt: new Date(now.getTime() - CLAIM_LEASE_MS + 1_000),
          claimedBy: "worker-still-working",
        },
      });

      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const result = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { workerId: "worker-other", now: () => now },
      );

      expect(result.found).toBe(0);
      expect(sender.sendStatusUpdate).not.toHaveBeenCalled();
    });

    it("does not resend an already processed job", async () => {
      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };

      const first = await processNotificationBatch(prisma, sender, silentLogger);
      const second = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
      );

      expect(first.delivered).toBe(1);
      expect(second).toEqual({
        found: 0,
        delivered: 0,
        failed: 0,
        deadLettered: 0,
      });
      expect(sender.sendStatusUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not deliver twice for the same provider idempotency key", async () => {
      const provider = new MockEmailProvider();
      const sent = vi.spyOn(console, "info").mockImplementation(() => {});

      const notification = {
        idempotencyKey: "evt-1",
        recipient: "someone@example.test",
        customerName: "Someone",
        applicationId: "application-worker",
        status: "IN_REVIEW",
        reason: null,
      };

      await provider.sendStatusUpdate(notification);
      await provider.sendStatusUpdate(notification);

      const messages = sent.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((m) => m.startsWith("[email] sent"))).toHaveLength(
        1,
      );
      expect(
        messages.filter((m) => m.startsWith("[email] skipped duplicate")),
      ).toHaveLength(1);
      sent.mockRestore();
    });
  });

  describe("boundary conditions", () => {
    it("reports an empty batch when there is no pending work", async () => {
      await prisma.notificationJob.deleteMany();
      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };

      const result = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
      );

      expect(result).toEqual({
        found: 0,
        delivered: 0,
        failed: 0,
        deadLettered: 0,
      });
      expect(sender.sendStatusUpdate).not.toHaveBeenCalled();
    });

    it("fails a job whose application has been removed", async () => {
      await prisma.loanApplication.deleteMany({
        where: { id: "application-worker" },
      });

      const sender = { sendStatusUpdate: vi.fn().mockResolvedValue(undefined) };
      const result = await processNotificationBatch(
        prisma,
        sender,
        silentLogger,
        { now: () => new Date("2026-08-25T10:00:00.000Z") },
      );

      // The job row is cascade-deleted with the application, so there is
      // nothing left to process.
      expect(result.delivered).toBe(0);
      expect(sender.sendStatusUpdate).not.toHaveBeenCalled();
    });
  });
});
