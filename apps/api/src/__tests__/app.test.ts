import { randomUUID } from "node:crypto";
import { prisma } from "@assessment/database";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

async function resetApplication() {
  await prisma.notificationJob.deleteMany();
  await prisma.applicationStatusHistory.deleteMany();
  await prisma.loanApplication.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.customer.create({
    data: {
      id: "customer-a",
      name: "Test Customer",
      email: "customer@example.test",
      phone: "+201111111111",
      applications: {
        create: {
          id: "application-a",
          status: "SUBMITTED",
          requestedAmountCents: 100_000_00,
          lastEventOccurredAt: new Date("2026-08-20T08:00:00.000Z"),
          history: {
            create: {
              id: randomUUID(),
              status: "SUBMITTED",
              sourceEventId: "initial-event",
              occurredAt: new Date("2026-08-20T08:00:00.000Z"),
            },
          },
        },
      },
    },
  });

  // A second customer, so ownership can actually be exercised. With a single
  // customer the authorization checks below are unrepresentable.
  await prisma.customer.create({
    data: {
      id: "customer-b",
      name: "Other Customer",
      email: "other@example.test",
      phone: "+201222222222",
      applications: {
        create: {
          id: "application-b",
          status: "SUBMITTED",
          requestedAmountCents: 50_000_00,
        },
      },
    },
  });
}

describe("application API", () => {
  beforeEach(resetApplication);

  it("returns an application with its history", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/v1/applications/application-a",
      headers: { "x-customer-id": "customer-a" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "application-a",
      status: "SUBMITTED",
      customer: { id: "customer-a" },
      history: [{ status: "SUBMITTED" }],
    });
    await app.close();
  });

  it("records a valid partner event and queues a notification", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: {
        eventId: "partner-event-1",
        status: "IN_REVIEW",
        occurredAt: "2026-08-20T09:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().application.status).toBe("IN_REVIEW");
    await expect(
      prisma.applicationStatusHistory.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationJob.count({
        where: { sourceEventId: "partner-event-1" },
      }),
    ).resolves.toBe(1);
    await app.close();
  });

  it("rejects malformed partner events", async () => {
    const app = buildApp({ database: prisma, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/applications/application-a/status-events",
      payload: { eventId: "", status: "UNKNOWN", occurredAt: "yesterday" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  describe("authorization", () => {
    it("does not reveal another customer's application", async () => {
      const app = buildApp({ database: prisma, logger: false });

      const foreign = await app.inject({
        method: "GET",
        url: "/v1/applications/application-b",
        headers: { "x-customer-id": "customer-a" },
      });

      const missing = await app.inject({
        method: "GET",
        url: "/v1/applications/does-not-exist",
        headers: { "x-customer-id": "customer-a" },
      });

      expect(foreign.statusCode).toBe(404);
      // Identical response, so the caller cannot tell an application it does
      // not own from one that does not exist.
      expect(foreign.statusCode).toBe(missing.statusCode);
      expect(foreign.body).toBe(missing.body);
      expect(foreign.body).not.toContain("other@example.test");
      expect(foreign.body).not.toContain("Other Customer");
      await app.close();
    });

    it("lets the owner read their own application", async () => {
      const app = buildApp({ database: prisma, logger: false });
      const response = await app.inject({
        method: "GET",
        url: "/v1/applications/application-b",
        headers: { "x-customer-id": "customer-b" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: "application-b" });
      await app.close();
    });

    it("requires a customer identity", async () => {
      const app = buildApp({ database: prisma, logger: false });

      const missingHeader = await app.inject({
        method: "GET",
        url: "/v1/applications/application-a",
      });
      const emptyHeader = await app.inject({
        method: "GET",
        url: "/v1/applications/application-a",
        headers: { "x-customer-id": "" },
      });
      // Whitespace is not an identity and must not reach the ownership query.
      const whitespaceHeader = await app.inject({
        method: "GET",
        url: "/v1/applications/application-a",
        headers: { "x-customer-id": "   " },
      });

      expect(missingHeader.statusCode).toBe(401);
      expect(emptyHeader.statusCode).toBe(401);
      expect(whitespaceHeader.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("duplicate delivery", () => {
    const event = {
      eventId: "partner-event-dup",
      status: "IN_REVIEW",
      occurredAt: "2026-08-20T09:00:00.000Z",
    };

    it("applies a retried event exactly once", async () => {
      const app = buildApp({ database: prisma, logger: false });

      const first = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: event,
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: event,
      });

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(200);
      expect(second.json().outcome).toBe("duplicate");

      await expect(
        prisma.applicationStatusHistory.count({
          where: { sourceEventId: event.eventId },
        }),
      ).resolves.toBe(1);
      // The customer must not be notified twice.
      await expect(
        prisma.notificationJob.count({
          where: { sourceEventId: event.eventId },
        }),
      ).resolves.toBe(1);
      await app.close();
    });

    it("treats a contradictory re-send of the same eventId as a duplicate", async () => {
      // The partner's eventId identifies one logical event, so the first
      // delivery is authoritative. A re-send carrying a different status is
      // the same event by definition and must not re-apply. Documented in
      // ISSUES.md P2-17, including the operational risk this accepts.
      const app = buildApp({ database: prisma, logger: false });

      await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-conflict",
          status: "IN_REVIEW",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });

      const contradictory = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-conflict",
          status: "DECLINED",
          occurredAt: "2026-08-22T10:00:00.000Z",
        },
      });

      expect(contradictory.statusCode).toBe(200);
      expect(contradictory.json().outcome).toBe("duplicate");

      const application = await prisma.loanApplication.findUniqueOrThrow({
        where: { id: "application-a" },
      });
      expect(application.status).toBe("IN_REVIEW");
      await expect(
        prisma.applicationStatusHistory.count({
          where: { sourceEventId: "event-conflict" },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.notificationJob.count({
          where: { sourceEventId: "event-conflict" },
        }),
      ).resolves.toBe(1);
      await app.close();
    });

    it("applies concurrent deliveries of the same event exactly once", async () => {
      const app = buildApp({ database: prisma, logger: false });

      // Races past the duplicate lookup, so this exercises the unique
      // constraint rather than the in-code check.
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          app.inject({
            method: "POST",
            url: "/v1/applications/application-a/status-events",
            payload: event,
          }),
        ),
      );

      const accepted = responses.filter((r) => r.statusCode === 202);
      expect(accepted).toHaveLength(1);
      expect(responses.every((r) => [202, 200].includes(r.statusCode))).toBe(
        true,
      );

      await expect(
        prisma.applicationStatusHistory.count({
          where: { sourceEventId: event.eventId },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.notificationJob.count({
          where: { sourceEventId: event.eventId },
        }),
      ).resolves.toBe(1);
      await app.close();
    });
  });

  describe("ordering and state transitions", () => {
    it("rejects an event older than the last accepted event", async () => {
      const app = buildApp({ database: prisma, logger: false });

      await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-new",
          status: "IN_REVIEW",
          occurredAt: "2026-08-22T10:00:00.000Z",
        },
      });

      const stale = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-late",
          status: "DECLINED",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });

      expect(stale.statusCode).toBe(409);
      expect(stale.json().outcome).toBe("stale");

      const application = await prisma.loanApplication.findUniqueOrThrow({
        where: { id: "application-a" },
      });
      expect(application.status).toBe("IN_REVIEW");
      expect(application.lastEventOccurredAt?.toISOString()).toBe(
        "2026-08-22T10:00:00.000Z",
      );
      await expect(
        prisma.notificationJob.count({
          where: { sourceEventId: "event-late" },
        }),
      ).resolves.toBe(0);
      await app.close();
    });

    it("rejects an event equal to the high-water mark", async () => {
      const app = buildApp({ database: prisma, logger: false });

      // The fixture's lastEventOccurredAt is 2026-08-20T08:00:00.000Z.
      const response = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-equal",
          status: "IN_REVIEW",
          occurredAt: "2026-08-20T08:00:00.000Z",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().outcome).toBe("stale");
      await app.close();
    });

    it("rejects a status change that skips the lifecycle", async () => {
      const app = buildApp({ database: prisma, logger: false });

      const response = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-skip",
          status: "DISBURSED",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        outcome: "invalid_transition",
        from: "SUBMITTED",
        to: "DISBURSED",
      });

      const application = await prisma.loanApplication.findUniqueOrThrow({
        where: { id: "application-a" },
      });
      expect(application.status).toBe("SUBMITTED");
      await app.close();
    });

    it("rejects any change once the application is terminal", async () => {
      const app = buildApp({ database: prisma, logger: false });

      const declined = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-declined",
          status: "DECLINED",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });
      expect(declined.statusCode).toBe(202);

      const afterTerminal = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-after-terminal",
          status: "IN_REVIEW",
          occurredAt: "2026-08-22T10:00:00.000Z",
        },
      });

      expect(afterTerminal.statusCode).toBe(409);
      expect(afterTerminal.json().outcome).toBe("invalid_transition");

      const application = await prisma.loanApplication.findUniqueOrThrow({
        where: { id: "application-a" },
      });
      expect(application.status).toBe("DECLINED");
      await app.close();
    });

    it("accepts the full lifecycle in order", async () => {
      const app = buildApp({ database: prisma, logger: false });
      const lifecycle = [
        ["IN_REVIEW", "2026-08-21T10:00:00.000Z"],
        ["OFFERED", "2026-08-22T10:00:00.000Z"],
        ["APPROVED", "2026-08-23T10:00:00.000Z"],
        ["DISBURSED", "2026-08-24T10:00:00.000Z"],
      ] as const;

      for (const [status, occurredAt] of lifecycle) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/applications/application-a/status-events",
          payload: { eventId: `event-${status}`, status, occurredAt },
        });
        expect(response.statusCode).toBe(202);
      }

      const application = await prisma.loanApplication.findUniqueOrThrow({
        where: { id: "application-a" },
      });
      expect(application.status).toBe("DISBURSED");
      await expect(
        prisma.notificationJob.count({
          where: { applicationId: "application-a" },
        }),
      ).resolves.toBe(4);
      await app.close();
    });

    it("returns 404 for an unknown application", async () => {
      const app = buildApp({ database: prisma, logger: false });
      const response = await app.inject({
        method: "POST",
        url: "/v1/applications/does-not-exist/status-events",
        payload: {
          eventId: "event-unknown-app",
          status: "IN_REVIEW",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("transaction boundary", () => {
    it("leaves no partial state when the notification write fails", async () => {
      // Fail the last write of the transaction. The status update and history
      // entry are written before it, so this proves they are rolled back
      // rather than left behind. The failure is injected into the transaction
      // client itself, so the real transaction still runs and really aborts.
      const failing = Object.create(prisma) as typeof prisma;
      Object.defineProperty(failing, "$transaction", {
        value: (callback: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction(async (tx) => {
            const failingTx = Object.create(tx as object);
            Object.defineProperty(failingTx, "notificationJob", {
              value: {
                create: () =>
                  Promise.reject(new Error("notification store is down")),
              },
            });
            return await callback(failingTx);
          }),
      });

      const app = buildApp({ database: failing, logger: false });
      const response = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-partial",
          status: "IN_REVIEW",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });

      expect(response.statusCode).toBe(500);

      const application = await prisma.loanApplication.findUniqueOrThrow({
        where: { id: "application-a" },
      });
      expect(application.status).toBe("SUBMITTED");
      expect(application.lastEventOccurredAt?.toISOString()).toBe(
        "2026-08-20T08:00:00.000Z",
      );
      await expect(
        prisma.applicationStatusHistory.count({
          where: { sourceEventId: "event-partial" },
        }),
      ).resolves.toBe(0);
      await app.close();
    });
  });
  describe("partner endpoint exposure", () => {
    const pii = ["Test Customer", "customer@example.test", "+201111111111"];

    it("never returns customer contact details to the partner", async () => {
      const app = buildApp({ database: prisma, logger: false });

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-pii-1",
          status: "IN_REVIEW",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });
      const duplicate = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-pii-1",
          status: "IN_REVIEW",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });
      const stale = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-pii-2",
          status: "OFFERED",
          occurredAt: "2026-08-20T07:00:00.000Z",
        },
      });
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-pii-3",
          status: "DISBURSED",
          occurredAt: "2026-08-23T10:00:00.000Z",
        },
      });

      expect(accepted.statusCode).toBe(202);
      expect(duplicate.statusCode).toBe(200);
      expect(stale.statusCode).toBe(409);
      expect(invalid.statusCode).toBe(409);

      // Every outcome, not just the happy one.
      for (const response of [accepted, duplicate, stale, invalid]) {
        for (const secret of pii) {
          expect(response.body).not.toContain(secret);
        }
        expect(response.json().application).not.toHaveProperty("customer");
      }

      // The partner still gets what it needs to reconcile the delivery.
      expect(accepted.json().application).toMatchObject({
        id: "application-a",
        status: "IN_REVIEW",
      });
      await app.close();
    });

    it("does not leak internal details when something fails unexpectedly", async () => {
      const failing = Object.create(prisma) as typeof prisma;
      Object.defineProperty(failing, "$transaction", {
        value: () =>
          Promise.reject(
            new Error(
              "connect ECONNREFUSED 10.0.0.5:5432 internal-db-primary",
            ),
          ),
      });

      const app = buildApp({ database: failing, logger: false });
      const response = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: {
          eventId: "event-boom",
          status: "IN_REVIEW",
          occurredAt: "2026-08-21T10:00:00.000Z",
        },
      });

      expect(response.statusCode).toBe(500);
      for (const leak of [
        "ECONNREFUSED",
        "10.0.0.5",
        "5432",
        "internal-db-primary",
      ]) {
        expect(response.body).not.toContain(leak);
      }
      expect(response.json()).toMatchObject({ error: "internal server error" });
      await app.close();
    });

    it("still reports malformed input to the caller", async () => {
      // The generic 500 must not swallow useful 4xx feedback.
      const app = buildApp({ database: prisma, logger: false });
      const response = await app.inject({
        method: "POST",
        url: "/v1/applications/application-a/status-events",
        payload: { eventId: "", status: "UNKNOWN", occurredAt: "yesterday" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid status event");
      await app.close();
    });
  });
});
