import { randomUUID } from "node:crypto";
import {
  canTransition,
  NOTIFICATION_TYPE_STATUS_CHANGED,
  type ApplicationStatus,
  type ApplicationView,
  type StatusEventInput,
} from "@assessment/contracts";
import { Prisma, type PrismaClient } from "@assessment/database";

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found`);
    this.name = "ApplicationNotFoundError";
  }
}

/**
 * Outcome of applying a partner status event.
 *
 * docs/DOMAIN.md requires the adapter to distinguish malformed input, an
 * unknown application, a duplicate delivery, a stale or invalid change, and an
 * accepted change. Malformed input and unknown applications are handled at the
 * route; the remaining cases are modelled here rather than thrown, because they
 * are expected outcomes of a healthy integration, not exceptions.
 */
export type RecordStatusEventResult =
  | { outcome: "accepted"; application: ApplicationView }
  | { outcome: "duplicate"; application: ApplicationView }
  | {
      outcome: "stale";
      application: ApplicationView;
      lastEventOccurredAt: string | null;
    }
  | {
      outcome: "invalid_transition";
      application: ApplicationView;
      from: ApplicationStatus;
      to: ApplicationStatus;
    };

/** Prisma's unique-constraint violation. */
const UNIQUE_CONSTRAINT_FAILED = "P2002";

type DatabaseClient = Pick<
  PrismaClient,
  "loanApplication" | "applicationStatusHistory" | "notificationJob"
>;

function toApplicationView(application: {
  id: string;
  status: string;
  requestedAmountCents: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  customer: { id: string; name: string; email: string; phone: string };
  history: Array<{
    id: string;
    status: string;
    reason: string | null;
    occurredAt: Date;
    recordedAt: Date;
  }>;
}): ApplicationView {
  return {
    id: application.id,
    status: application.status as ApplicationStatus,
    requestedAmountCents: application.requestedAmountCents,
    currency: application.currency,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    customer: {
      id: application.customer.id,
      name: application.customer.name,
      email: application.customer.email,
      phone: application.customer.phone,
    },
    history: application.history.map((entry) => ({
      id: entry.id,
      status: entry.status as ApplicationStatus,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
      recordedAt: entry.recordedAt.toISOString(),
    })),
  };
}

async function loadApplicationView(
  database: DatabaseClient,
  applicationId: string,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findUnique({
    where: { id: applicationId },
    include: {
      customer: true,
      history: { orderBy: { occurredAt: "desc" } },
    },
  });

  return application ? toApplicationView(application) : null;
}

/**
 * Reads an application on behalf of a customer.
 *
 * Ownership is enforced in the query rather than after the fetch, so another
 * customer's record is never loaded into memory. Callers cannot distinguish
 * "does not exist" from "not yours" — see docs/DOMAIN.md, which requires the
 * API not to disclose whether an inaccessible application exists.
 */
export async function getApplicationForCustomer(
  database: DatabaseClient,
  applicationId: string,
  customerId: string,
): Promise<ApplicationView | null> {
  const application = await database.loanApplication.findFirst({
    where: { id: applicationId, customerId },
    include: {
      customer: true,
      history: { orderBy: { occurredAt: "desc" } },
    },
  });

  return application ? toApplicationView(application) : null;
}

/**
 * Applies a partner status event.
 *
 * All reads and writes run inside a single transaction so that the application
 * row, the history entry, and the notification request form one logical change
 * (docs/DOMAIN.md). Checks run cheapest-first: duplicate, then staleness, then
 * transition validity.
 */
export async function recordStatusEvent(
  database: PrismaClient,
  applicationId: string,
  event: StatusEventInput,
): Promise<RecordStatusEventResult> {
  const occurredAt = new Date(event.occurredAt);

  try {
    return await database.$transaction(async (tx) => {
      const application = await tx.loanApplication.findUnique({
        where: { id: applicationId },
      });

      if (!application) throw new ApplicationNotFoundError(applicationId);

      // Duplicate delivery: the partner retried an event we already applied.
      // The unique constraint on (applicationId, sourceEventId) is the real
      // guarantee; this lookup just avoids an exception on the common path.
      const existing = await tx.applicationStatusHistory.findFirst({
        where: { applicationId, sourceEventId: event.eventId },
      });

      if (existing) {
        return {
          outcome: "duplicate" as const,
          application: await requireView(tx, applicationId),
        };
      }

      // Out-of-order delivery: current state must describe the newest accepted
      // business event, not the last HTTP request received. lastEventOccurredAt
      // is a high-water mark that only ever moves forward. An equal timestamp is
      // treated as stale; a true replay was already caught above.
      if (
        application.lastEventOccurredAt &&
        occurredAt <= application.lastEventOccurredAt
      ) {
        return {
          outcome: "stale" as const,
          application: await requireView(tx, applicationId),
          lastEventOccurredAt: application.lastEventOccurredAt.toISOString(),
        };
      }

      const from = application.status as ApplicationStatus;
      if (!canTransition(from, event.status)) {
        return {
          outcome: "invalid_transition" as const,
          application: await requireView(tx, applicationId),
          from,
          to: event.status,
        };
      }

      await tx.loanApplication.update({
        where: { id: applicationId },
        data: { status: event.status, lastEventOccurredAt: occurredAt },
      });

      await tx.applicationStatusHistory.create({
        data: {
          id: randomUUID(),
          applicationId,
          status: event.status,
          reason: event.reason,
          sourceEventId: event.eventId,
          occurredAt,
        },
      });

      await tx.notificationJob.create({
        data: {
          id: randomUUID(),
          applicationId,
          sourceEventId: event.eventId,
          type: NOTIFICATION_TYPE_STATUS_CHANGED,
          payload: JSON.stringify({
            status: event.status,
            reason: event.reason ?? null,
          }),
        },
      });

      return {
        outcome: "accepted" as const,
        application: await requireView(tx, applicationId),
      };
    });
  } catch (error) {
    // Two deliveries of the same event raced past the duplicate lookup and the
    // database rejected the second. That is precisely the duplicate outcome.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_CONSTRAINT_FAILED
    ) {
      return {
        outcome: "duplicate",
        application: await requireView(database, applicationId),
      };
    }
    throw error;
  }
}

async function requireView(
  database: DatabaseClient,
  applicationId: string,
): Promise<ApplicationView> {
  const view = await loadApplicationView(database, applicationId);
  if (!view) throw new ApplicationNotFoundError(applicationId);
  return view;
}
