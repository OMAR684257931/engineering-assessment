import { z } from "zod";

export const APPLICATION_STATUSES = [
  "SUBMITTED",
  "IN_REVIEW",
  "OFFERED",
  "APPROVED",
  "DECLINED",
  "DISBURSED",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const statusEventSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  status: z.enum(APPLICATION_STATUSES),
  occurredAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type StatusEventInput = z.infer<typeof statusEventSchema>;

/**
 * Allowed status changes, from docs/DOMAIN.md:
 *
 *   SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED
 *                           \-> DECLINED
 *                 \---------------------> DECLINED
 *
 * DECLINED and DISBURSED are terminal: no event may move an application out of
 * them. An empty list therefore means "terminal".
 */
export const ALLOWED_TRANSITIONS: Record<
  ApplicationStatus,
  readonly ApplicationStatus[]
> = {
  SUBMITTED: ["IN_REVIEW", "DECLINED"],
  IN_REVIEW: ["OFFERED", "DECLINED"],
  OFFERED: ["APPROVED", "DECLINED"],
  APPROVED: ["DISBURSED", "DECLINED"],
  DECLINED: [],
  DISBURSED: [],
};

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export const NOTIFICATION_TYPE_STATUS_CHANGED =
  "APPLICATION_STATUS_CHANGED" as const;

/**
 * Shape written to NotificationJob.payload by the API and read by the worker.
 * Shared so the producer and consumer cannot drift.
 */
export const notificationPayloadSchema = z.object({
  status: z.enum(APPLICATION_STATUSES),
  reason: z.string().nullable().default(null),
});

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;

export interface ApplicationView {
  id: string;
  status: ApplicationStatus;
  requestedAmountCents: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string;
  };
  history: Array<{
    id: string;
    status: ApplicationStatus;
    reason: string | null;
    occurredAt: string;
    recordedAt: string;
  }>;
}
