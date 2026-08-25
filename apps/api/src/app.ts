import { statusEventSchema } from "@assessment/contracts";
import { prisma, type PrismaClient } from "@assessment/database";
import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import {
  ApplicationNotFoundError,
  getApplicationForCustomer,
  recordStatusEvent,
} from "./application-service.js";

interface BuildAppOptions {
  database?: PrismaClient;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? prisma;
  const app = Fastify({ logger: options.logger ?? true });

  void app.register(cors, { origin: true });

  // Unexpected failures must not describe the internals to the caller. The
  // underlying error carries database hosts, connection strings, and SQL, and
  // the partner endpoint is unauthenticated. Log it server-side, return a
  // generic body. Fastify's own 4xx responses (validation, bad JSON) are
  // passed through unchanged because they describe the caller's request.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error(
        { err: error, requestId: request.id },
        "unhandled error serving request",
      );
      return reply
        .code(500)
        .send({ error: "internal server error", requestId: request.id });
    }

    return reply.code(status).send({ error: error.message });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Params: { applicationId: string } }>(
    "/v1/applications/:applicationId",
    async (request, reply) => {
      // Trimmed before validation: a whitespace-only header is not an
      // identity, and must not be carried into the ownership query.
      const rawCustomerId = request.headers["x-customer-id"];
      const customerId =
        typeof rawCustomerId === "string" ? rawCustomerId.trim() : "";
      if (customerId.length === 0) {
        return reply.code(401).send({ error: "customer identity is required" });
      }

      const application = await getApplicationForCustomer(
        database,
        request.params.applicationId,
        customerId,
      );

      // An application the caller does not own is reported exactly as one that
      // does not exist, so the response cannot be used to probe for the
      // existence of other customers' applications.
      if (!application) {
        return reply.code(404).send({ error: "application not found" });
      }

      return application;
    },
  );

  app.post<{ Params: { applicationId: string } }>(
    "/v1/applications/:applicationId/status-events",
    async (request, reply) => {
      const parsed = statusEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid status event",
          details: parsed.error.flatten(),
        });
      }

      // Log identifiers only. `reason` is partner-supplied free text and may
      // carry personal data, so it is deliberately not logged.
      request.log.info(
        {
          applicationId: request.params.applicationId,
          eventId: parsed.data.eventId,
          status: parsed.data.status,
          occurredAt: parsed.data.occurredAt,
        },
        "received partner status event",
      );

      try {
        const result = await recordStatusEvent(
          database,
          request.params.applicationId,
          parsed.data,
        );

        // This endpoint is an unauthenticated partner adapter, so the response
        // carries only what the partner needs to reconcile its own delivery:
        // the application's identity and resulting status. Customer contact
        // details are deliberately withheld — the partner sent the event and
        // has no need for the applicant's name, email, or phone.
        const summary = {
          id: result.application.id,
          status: result.application.status,
        };

        switch (result.outcome) {
          // Already applied. 200 rather than 202 tells the partner the event
          // landed exactly once and needs no further delivery attempt.
          case "duplicate":
            return reply
              .code(200)
              .send({ outcome: "duplicate", application: summary });

          // Understood and rejected. Retrying will not change the result.
          case "stale":
            return reply.code(409).send({
              outcome: "stale",
              error: "event is older than the last accepted event",
              lastEventOccurredAt: result.lastEventOccurredAt,
              application: summary,
            });

          case "invalid_transition":
            return reply.code(409).send({
              outcome: "invalid_transition",
              error: `cannot change status from ${result.from} to ${result.to}`,
              from: result.from,
              to: result.to,
              application: summary,
            });

          case "accepted":
            return reply
              .code(202)
              .send({ outcome: "accepted", application: summary });
        }
      } catch (error) {
        if (error instanceof ApplicationNotFoundError) {
          return reply.code(404).send({ error: "application not found" });
        }
        throw error;
      }
    },
  );

  return app;
}
