# Issues found, and what I did about them

I inherited this system, ran the checks, read the code against `docs/DOMAIN.md`, and then wrote
throwaway scripts to *execute* each suspected defect rather than trusting my reading of it. The
evidence below is real output, not inference.

## The finding that framed everything else

Before changing anything, the baseline was:

| Check | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (5 projects) |
| `pnpm test` | **pass — 4/4** |
| `pnpm build` | pass |

**The suite was fully green while three separate P0 defects were live.** It passed *because* it only
asserted happy paths:

- `app.test.ts` read an application using its **owning** customer's id, so a missing ownership check
  was invisible to it.
- The duplicate-event assertion (`count === 1`) ran after sending an event **once**, which cannot
  detect duplicate handling by construction.

That is the reason I treated "make the tests pass" as the wrong goal, and why most of my effort went
into tests that fail against the original code.

## Proof of the defects (original code)

```
[1] IDOR - Alice requests Bob's application
    status: 200 | leaked: {"id":"cust-B","name":"Bob","email":"b@example.test","phone":"+2022"}
[2] Duplicate eventId sent twice - second status: 202
    history rows: 2 | notification jobs: 2
[3] DISBURSED, then LATE event dated 3 days EARLIER (also DISBURSED->SUBMITTED)
    stale event status: 202 | current status: SUBMITTED | lastEventOccurredAt: 2026-08-19...
[4] Provider FAILS (@retry.invalid). Batch 1: {"found":1,"delivered":0,"failed":1}
    processedAt: <set> | attemptCount: 1 | nextAttemptAt: null
    Batch 2: {"found":0,...} => job never retried, permanently lost
```

## Prioritized issues

Ranked by data integrity and security first, then reliability, then user-visible correctness.

### P0-1 — Any customer could read any application, including personal data
*Fixed.*

`app.ts` required an `x-customer-id` header but never compared it to the application's owner, and
`getApplication` filtered only by application id. Any caller supplying any non-empty header value
received another customer's name, email, and phone. Reachable from the UI by changing the URL — no
auth bypass needed. Violates `docs/DOMAIN.md` ("A customer may read only applications they own", and
"The API should not disclose whether an inaccessible application exists").

Ownership is now enforced **in the query** (`getApplicationForCustomer`), so another customer's row
is never loaded into memory, and both "not yours" and "does not exist" return a byte-identical 404.

### P0-2 — A retried partner event was applied twice, and emailed the customer twice
*Fixed.*

`recordStatusEvent` never checked `sourceEventId`. The `@@index([sourceEventId])` columns looked like
idempotency support but were **not unique**, so the database did not stop it either. The README
states partners retry deliveries, so this was certain to happen in normal operation. Violates
`docs/DOMAIN.md` ("An accepted logical event should have exactly one effect on the application
history and should request at most one customer notification").

Fixed with a `@@unique([applicationId, sourceEventId])` constraint as the real guarantee, plus an
in-transaction lookup for the fast path and a `P2002` catch for the race. Duplicates now return
`200 {"outcome":"duplicate"}` and write nothing.

### P0-3 — A failed notification was never retried
*Fixed.*

`processNotificationBatch` set `processedAt` inside a `finally` block, so a job was marked complete
even when the provider threw. Since the poll query filters `processedAt: null`, the job was never
picked up again: silently lost after one attempt, with no dead-letter state and no alert.
`nextAttemptAt` existed in the schema and was read by the query, but was written by nobody. The
seeded `omar@retry.invalid` customer exists precisely to exercise this path. Violates
`docs/DOMAIN.md` ("A failed attempt should remain eligible for a bounded retry policy. An operator
should be able to inspect and replay exhausted work").

`processedAt` is now set only on success. Failures schedule an exponential backoff; after
`MAX_ATTEMPTS` (5) the job is dead-lettered — excluded from polling but preserved with its
`attemptCount` and `lastError` for inspection and replay.

### P1-4 — Late events overwrote newer state
*Fixed.*

`lastEventOccurredAt` was written but never read. A delayed event silently rewound the application:
in proof [3] a `DISBURSED` loan reverted to `SUBMITTED`, and the timestamp moved *backwards*. For a
lending system this is a financial-integrity failure, not a display bug. Violates `docs/DOMAIN.md`
("Current state must describe the newest accepted business event, not merely the last HTTP request
received").

`lastEventOccurredAt` is now a per-application high-water mark that only moves forward. Older or
equal timestamps return `409 {"outcome":"stale"}` and write nothing.

### P1-5 — Three writes with no transaction
*Fixed.*

The application update, history row, and notification job were three independent `await`s. A failure
between them left status changed with no history, or history with no notification. Violates
`docs/DOMAIN.md` ("the current application state, immutable history, and notification request form
one logical change"). All three now run in a single `$transaction`.

I verified this test actually proves the guarantee: with `$transaction` removed the atomicity test
fails, and with it restored it passes. It is not a test that passes vacuously.

### P1-6 — No state machine; illegal transitions accepted
*Fixed.*

No transition map existed. `SUBMITTED → DISBURSED` skipped the entire lifecycle, and applications
could move out of the terminal `DECLINED`/`DISBURSED` states. The lifecycle in `docs/DOMAIN.md` is
now encoded once in `packages/contracts` as `ALLOWED_TRANSITIONS`; terminal states are represented
as an empty transition list, which makes leaving them impossible by construction rather than by a
separate check. Rejected changes return `409 {"outcome":"invalid_transition"}`.

### P2-7 — The partner could not tell outcomes apart
*Fixed.* `docs/DOMAIN.md` asks the adapter to distinguish malformed input, unknown application,
duplicate delivery, stale/invalid change, and acceptance. Only 400/404/202 existed, so a duplicate
and a stale event both looked like success. See the table in `DESIGN.md`.

### P2-8 — Concurrent workers would double-send
*Partly fixed — see the honest limits below.*

Jobs were selected and then processed with no claim at all, so two workers polling the same interval
both delivered.

My first attempt at this was wrong, and my own hostile review caught it. I claimed jobs with a
compare-and-swap on `claimedAt`, which stopped the same-instant race but placed **no lease** on the
claim — so a worker that was still mid-delivery had its job taken by the next poll. I reproduced a
genuine double-send: the provider was called twice and `attemptCount` showed a lost update. The
test I had written could not detect it, because both workers used instant mock providers and never
actually overlapped.

**What the lease now does.** A job is claimable only when `claimedAt IS NULL` or the claim is older
than `CLAIM_LEASE_MS` (30s). Both the candidate query and the claiming update enforce that rule, so
a second worker cannot take a job while the first is still working within its lease.

**What it does not do.** A delivery that runs *longer* than the lease can still be picked up a
second time. The lease reduces the window; it does not eliminate it. A shorter lease strands
crashed work for less time but reclaims live work sooner — that trade-off cannot be removed, only
chosen.

**How abandoned claims recover.** There is no reaper process. An expired lease simply makes the job
claimable again on the next poll, so a worker that dies holding a claim costs at most one lease
period. This is deliberate: a crashed worker must never hold a job forever.

**What guarantee actually exists: at-least-once delivery, not exactly-once.** Exactly-once is not
achievable here and I do not claim it. The provider call carries an idempotency key so a redelivery
*can* be suppressed, but `MockEmailProvider` tracks keys in an in-memory `Set` scoped to one
process — I verified that two provider instances both send. Real deduplication requires the provider
to honour the key server-side, which is a property of the provider contract, not of this code.

Tests: an overlapping-worker test where worker A blocks inside the provider call on a controllable
promise while worker B polls (B must claim nothing and call nothing), plus stale-claim recovery and
live-lease protection. I confirmed the overlapping test fails against the old CAS-only code.

### P2-9 — One bad row could kill the worker
*Fixed.* An exception in the `finally` bookkeeping update escaped the batch and propagated to
`process.exit(1)`, and `JSON.parse(job.payload)` was unguarded. A single malformed row could stop
all notifications. Failures are now isolated per job, and payloads are parsed against a shared
schema so a poison message dead-letters itself.

### P2-10 — The web app crashed instead of handling errors
*Fixed (deliberately thin).* Any non-2xx threw a bare `Error`, and there was no `error.tsx` or
`not-found.tsx`, so a 404 produced an unstyled server-exception screen. Added a proper not-found
page, an error boundary, a request timeout, and an empty-history state. The backend is where the
risk was, so I kept this proportionate.

### P2-11 — Producer and consumer payload types could drift
*Fixed.* The worker did not depend on `@assessment/contracts` and re-declared the payload inline as
`{ status: string }`, silently dropping the `reason` the API wrote. Now a shared schema.

### P3-12 — `vitest.config.ts` excluded `packages/**`
*Fixed (one line).* Any test added under `packages/` would never have run.

## Found later, by reviewing my own finished work

The issues above came from the first pass over the inherited code. The ones below came from
reviewing my *own* implementation adversarially once it was green — so they are numbered in the
order I found them, not in priority order. Severity is still marked on each. I kept them in
discovery order deliberately: where a defect came from is part of the evidence, and P1-13 in
particular is a defect I introduced into my own fix and then caught.

### P1-13 — The unauthenticated partner endpoint returned customer PII
*Fixed.* Found by my own hostile review after the first implementation pass. The POST response
echoed the full `ApplicationView` — name, email, and phone — in every outcome branch, to a caller
with no credentials. Anyone who guessed an application id could harvest contact details. The
response now carries only `{ id, status }`, which is all the partner needs to reconcile its own
delivery. Asserted for all four outcomes, not just the happy path.

### P1-14 — 500 responses leaked internal infrastructure detail
*Fixed.* Also from the hostile review. Fastify's default error handler returned the raw message, so
an unauthenticated caller could see e.g. `connect ECONNREFUSED 10.0.0.5:5432 internal-db-primary`.
The API now logs the error server-side with a request id and returns
`{ "error": "internal server error", "requestId": … }`. Fastify's own 4xx responses are passed
through unchanged, so malformed input is still reported usefully — there is a test for that, because
a generic handler that swallows 400s would be a worse bug than the one it fixed.

### P2-17 — A duplicate `eventId` carrying a *different* payload is ignored
*Investigated; behaviour deliberately kept, now documented.*

Verified by execution: sending `eventId=X` as `IN_REVIEW` and then `eventId=X` as `DECLINED` returns
`200 {"outcome":"duplicate"}` and the second payload is discarded — the application stays
`IN_REVIEW`.

**I kept this, on purpose.** `eventId` is the partner's stable identifier for one logical event, and
`docs/DOMAIN.md` states an accepted logical event must have exactly one effect. Under that contract
the first delivery is authoritative and a contradictory re-send is, by definition, the same event —
so re-applying it would be the bug. Detecting the conflict instead would mean defining what "the
same payload" means (does `reason` count? whitespace? key order?), storing a payload fingerprint,
and choosing a status code for a case that only occurs when the partner is malfunctioning. That is
real complexity added to the hot path for a condition this system cannot correctly resolve anyway:
if the partner sends two different bodies under one id, we have no way to know which is true.

**The operational risk, stated plainly:** a partner bug of this shape is silent here. We would
accept `IN_REVIEW`, discard `DECLINED`, and report success — and nothing would alert. That is a real
gap, and the mitigation belongs in the production design rather than in this endpoint: the event log
in `DESIGN.md` records every delivery including rejected and duplicate ones, so the conflict becomes
visible in the audit trail and can be alerted on, without the ingestion path having to adjudicate it
in real time.

### P3-15 — Whitespace-only `x-customer-id` was treated as an identity
*Fixed.* `"   "` passed the `length === 0` check and reached the ownership query. Not exploitable
(it matched no owner, so it 404'd) but the header is now trimmed before validation.

### P3-16 — A delivered job kept a stale `nextAttemptAt`
*Fixed.* Harmless, since `processedAt` gates the poll query, but it left contradictory bookkeeping
on the row. Cleared on success.

## Deliberately not changed, and why

These are real, but they are not this slice. Naming them precisely is more useful than half-fixing
them.

| Issue | Why I left it |
| --- | --- |
| Partner endpoint has no authentication | `docs/DOMAIN.md` explicitly places this outside the exercise; its trust boundary is covered in `DESIGN.md`. Note the endpoint no longer returns PII, so the unauthenticated surface is now much smaller. |
| CORS reflects any origin (`origin: true`) | A real fix needs an allowlist per environment, which needs config I would be inventing. Documented instead. |
| No migration history (`db push --accept-data-loss`) | Introducing migrations would be a plausible-looking fabrication of history the repo never had. The production path (expand/contract, backfill, rollback) is in `DESIGN.md`. **This is the change I am least comfortable shipping without**, because adding a unique index to a real table with existing duplicates would fail. |
| SQLite → Postgres | Rewrites the data layer; the *design* is the deliverable. |
| Real sessions/JWT instead of the header | The header is an intentional stand-in per `docs/DOMAIN.md`. |
| Worker shutdown is not graceful | `shutdown()` disconnects Prisma without awaiting the in-flight batch. Real but narrow; job claims are released on the next successful pass. |
| Tests share one SQLite file with a global truncate | Works today via `--no-file-parallelism`. Reworking isolation is a test-infrastructure project with little effect on the risks above. |
| Web identity hardcoded to `cus_amina_001` | Demo-only concern; changing it implies building an auth flow. |
| Prisma 6 → 7 upgrade | Unrelated churn with real regression risk inside a timebox. |

## Scope note

The brief asks for one vertical slice, and I treated authorization and event integrity as one:
both concern whether the customer-visible history can be trusted. History is only trustworthy if it
is also private, and both live in the same read/write path in `application-service.ts`. I did not
add unrelated features.
