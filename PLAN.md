# Known limitations and next steps

What I actually built, what it does not do, and what I would pick up next. Written after the
implementation, so it describes the shipped state rather than the intention.

## What was delivered

One vertical slice: **a partner status event is recorded exactly once, in the right order, and
notifies only its rightful owner.** It crosses the API, the domain logic, the database, the
background worker, the notification provider, and the web app, with tests at each layer.

"Exactly once" describes *ingestion*, which the database enforces. Outbound notification is
at-least-once — see the claim-lease limitation below.

Verified with `pnpm check` (lint, typecheck, 36 tests, build), plus a manual end-to-end run against
a live API, worker, and web server.

## Known limitations

### Ordering depends on partner clocks
`lastEventOccurredAt` is a high-water mark over the partner's `occurredAt`. If the partner's clock
skews backwards, legitimate events are rejected as stale; if two genuine events share a timestamp,
the second is rejected. There is no sequence number in the contract to order by instead. The
conservative choice — refuse to overwrite — is right for a lending system, but it can drop real
updates. **Next:** ask the partner for a monotonic per-application sequence and order on
`(sequence, occurredAt)`.

### A rejected event leaves no trace
Stale and invalid-transition events return 409 and write nothing at all. Nothing records that the
partner sent them. That is a gap for a system whose history "may later be used as operational
evidence" — you cannot prove what you refused. **Next:** append every delivery to an event log and
let the projection reject it, rather than dropping it at the door.

### No migration path for the unique constraints
The repo has no migration history; schema changes are applied with `prisma db push
--accept-data-loss`. I did not fabricate one. This matters concretely: adding
`@@unique([applicationId, sourceEventId])` to a real table containing duplicate rows **would fail**.
The seed has no duplicates, so the exercise never exercises it. `DESIGN.md` describes the real
sequence (dedupe → build concurrently → enforce). **This is the single largest gap between this
code and something deployable.**

### SQLite is not a fair test of the concurrency guarantees
The concurrency tests pass, and they do prove the unique constraint is doing the work rather than
the in-code check. But SQLite serialises writers, so they do not prove behaviour under Postgres
isolation, nor under real parallelism across processes. Worker claiming uses a conditional
`updateMany` rather than `SELECT … FOR UPDATE`, which is correct here but is not the production
mechanism. **Next:** rerun these tests against Postgres before trusting them.

### The claim lease narrows double-delivery but does not eliminate it
A job is claimable only when unclaimed or when its claim is older than `CLAIM_LEASE_MS` (30s), so a
second worker cannot take a job that is actively being delivered inside that window. A delivery that
runs *longer* than the lease can still be reclaimed and sent twice. There is no heartbeat to renew a
lease mid-delivery, and the 30s value is chosen against the mock provider's 75ms rather than measured
against a real one. Recovery of abandoned work relies on lease expiry alone — there is no reaper —
which is deliberate, since a crashed worker must not hold a job forever.

**The guarantee is at-least-once delivery, not exactly-once.** Ingestion of partner events is
effectively exactly-once because the database enforces it; outbound email is not, and cannot be while
the final hop is a third party. The provider idempotency key exists to let a well-behaved provider
suppress a redelivery, but `MockEmailProvider` tracks keys in a per-process `Set` — verified not to
dedupe across two instances — so locally it demonstrates the contract rather than implementing it.

### Retry backoff has no jitter
Backoff is exponential (1s → 60s cap) with no randomisation, so multiple workers retrying the same
recovering provider stay phase-locked. Harmless at one worker; a thundering herd at ten.

### Retries do not distinguish retryable from terminal failures
Every failure gets the full five attempts, including ones that will never succeed (malformed
address, hard bounce). Wasteful and slow to surface the real problem.

### Dead-letter replay is a manual database operation
Jobs are dead-lettered with `attemptCount` and `lastError` preserved and are excluded from polling,
so they are inspectable — but there is no operator endpoint or CLI to replay one. `docs/DOMAIN.md`
asks that an operator be able to inspect *and replay*; only inspection is properly served.

### No alerting
Dead-lettered jobs are recorded and logged, and nothing watches them. The original bug was silent
notification loss; the current code makes loss *visible in the database* but still not *noisy*. A
DLQ nobody watches is still an outage.

### Worker shutdown is not graceful
`shutdown()` sets a stop flag and disconnects Prisma without awaiting the in-flight batch. A job can
be claimed when the process dies; the claim is not released on exit. It will be retried after its
backoff, so nothing is lost, but the window is untidy.

### Web app remains a single-tenant demo
The customer identity is still hardcoded (`DEMO_CUSTOMER_ID`, default `cus_amina_001`). The API now
enforces ownership correctly, so the leak is closed at the boundary that matters, but the front end
has no real session. Deliberately out of scope.

### Contradictory duplicates are silent
A partner that re-sends one `eventId` with a different status has its second payload discarded and
receives `200 duplicate`. This is the intended idempotency-key contract (ISSUES.md P2-17), but it
means a partner bug of that shape produces no signal here. The mitigation is the event log in
`DESIGN.md`, not a change to this endpoint.

### Untouched, and named in ISSUES.md
Partner endpoint authentication, CORS `origin: true`, and test-database isolation. Each is real;
none belongs to this slice.

## Next steps, in the order I would do them

1. **Alert on dead-letter depth and notification age.** Highest value per effort: it converts a
   silent failure into a paged one. Everything else assumes someone notices.
2. **Heartbeat the claim lease** so a slow delivery renews rather than expires, and derive the lease
   duration from measured p99 delivery time instead of a guess.
3. **Move to Postgres with versioned migrations**, and rerun the concurrency and atomicity tests
   there. This is the gate for trusting any of the guarantees above in production.
4. **Add the append-only event log** and derive state from it, so rejected events are recorded and a
   projection bug is repairable by replay rather than by hand.
5. **Operator replay path** for dead-lettered jobs, through the normal delivery code.
6. **Jitter plus retryable/terminal classification** in the backoff policy.
7. **Ask the partner for a sequence number**; ordering is currently as good as their clock.
8. **Replace polling with a real queue** partitioned by `applicationId`, behind a transactional
   outbox. Deferred until the boundaries above are settled, because it is a rewrite rather than a
   fix.
9. **Real sessions** in the web app, retiring the header stand-in.

## Verification

```sh
nvm use                       # Node 22; the repo requires >=22 <23
pnpm install --frozen-lockfile
pnpm db:generate && pnpm db:reset
pnpm check                    # lint + typecheck + test + build
pnpm dev                      # web :3000, api :3001, worker
```

Note: `pnpm-lock.yaml` was updated because the worker gained a dependency on
`@assessment/contracts`. CI runs `--frozen-lockfile`, so this had to be committed — I verified a
frozen install succeeds.
