# Domain and local contract

This document describes the intended product behavior.

## Application lifecycle

An application starts at `SUBMITTED` and may move through these states:

```text
SUBMITTED -> IN_REVIEW -> OFFERED -> APPROVED -> DISBURSED
                        \-> DECLINED
              \---------------------> DECLINED
```

Terminal states are `DECLINED` and `DISBURSED`. A partner event contains the partner's stable event identifier, the new status, the time the change occurred in the partner system, and an optional human-readable reason.

The partner can retry delivery, and network delays can change delivery order. An accepted logical event should have exactly one effect on the application history and should request at most one customer notification. Current state must describe the newest accepted business event, not merely the last HTTP request received.

For an accepted status change, the current application state, immutable history, and notification request form one logical change. History is customer-visible and may later be used as operational evidence.

## Access

The local customer API uses `x-customer-id` as a deliberately simple stand-in for an authenticated session. Treat the value as caller-controlled. A customer may read only applications they own.

The partner event endpoint represents an internal integration adapter. Authentication of that adapter is not implemented in the exercise, but the production design should explain its trust boundary.

## HTTP API

### `GET /health`

Returns `{ "status": "ok" }`.

### `GET /v1/applications/:applicationId`

Requires the `x-customer-id` request header; the value is trimmed, so a blank or whitespace-only header is treated as missing. Returns the application, customer contact details, and status history ordered newest first.

A missing identity returns `401`. An application that does not exist, or exists but belongs to another customer, returns an identical `404` — the response does not disclose whether an inaccessible application exists.

### `POST /v1/applications/:applicationId/status-events`

Accepts JSON of this shape:

```json
{
  "eventId": "partner-event-100",
  "status": "IN_REVIEW",
  "occurredAt": "2026-08-20T10:30:00.000Z",
  "reason": "Documents received"
}
```

The adapter distinguishes each outcome so its caller can operate safely:

| Outcome | Status | Body |
| --- | --- | --- |
| Malformed input | `400` | `{ "error": "invalid status event", "details": … }` |
| Unknown application | `404` | `{ "error": "application not found" }` |
| Duplicate delivery | `200` | `{ "outcome": "duplicate", "application": … }` |
| Stale (older than the last accepted event) | `409` | `{ "outcome": "stale", "lastEventOccurredAt": … }` |
| Not a legal status change | `409` | `{ "outcome": "invalid_transition", "from": …, "to": … }` |
| Accepted | `202` | `{ "outcome": "accepted", "application": … }` |

`2xx` means the event is settled and should not be re-sent; `409` means it was understood and
rejected, so retrying will not change the result.

`eventId` is the idempotency key. A re-send under the same `eventId` is reported as a duplicate and
has no further effect, even if its payload differs from the original.

This endpoint is an unauthenticated integration adapter, so `application` here carries only
`{ id, status }` — never customer contact details. Unexpected failures return
`{ "error": "internal server error", "requestId": … }` without internal detail.

## Notifications

The worker polls pending notification jobs and calls a mock email provider. Addresses ending in `@retry.invalid` simulate a temporarily unavailable provider. A failed attempt should remain eligible for a bounded retry policy. An operator should be able to inspect and replay exhausted work.

Multiple worker processes may eventually run at the same time. Provider calls should carry an idempotency key because a process can stop after the provider accepts a request but before local state is recorded.

## Money and time

Money is stored as integer minor units (`requestedAmountCents`) with an ISO currency code. Partner timestamps are UTC ISO-8601 values. Customer-facing formatting currently targets Egypt.
