# Tools and models

The README asks what tools I used, why, how I used them, and how I checked the output.

## What I used

| Tool | Used for |
| --- | --- |
| Claude (Opus 5) via Claude Code | Reading the codebase, drafting the implementation and tests, drafting these documents |
| `pnpm` / `vitest` / `tsc` / `eslint` / `next build` | The repository's own verification commands |
| `prisma` CLI | Client generation, `db push`, inspecting the SQLite database |
| `curl` + throwaway `tsx` scripts | Executing defects and verifying fixes end-to-end |
| `git diff` | Reviewing my own change before finishing |

## How I used them

**Assessment before code.** I read every source file, then had two parallel agent passes explore the
repository independently — one over the API and data layer, one over the web app, worker, and tests.
I used their reports as a cross-check on my own reading rather than as the source of truth. Both
independently surfaced the same defects I had found, and each added something I had missed: that the
worker's `finally` block could itself throw and kill the process, and that `vitest.config.ts`
excluded `packages/**`.

**Establishing a baseline first.** Before changing anything I ran `lint`, `typecheck`, `test`, and
`build`. All four passed. That result — a green suite hiding three P0 defects — shaped the whole
submission, and I would not have had it if I had started by writing code.

**Proving rather than trusting.** The most important thing I did with the model's output was refuse
to take it at face value. For each suspected defect I wrote a throwaway script that executed it
against a scratch database, and kept the actual output. That is where the evidence in `ISSUES.md`
comes from. Reading code tells you what you think it does; running it tells you what it does.

## How I checked the output

- **Every claim in the documents is backed by a command I ran.** The before/after outputs in
  `ISSUES.md` are real terminal output, not reconstructions.
- **I mutation-tested the most important test.** The atomicity test only means something if it fails
  when the transaction is removed. I removed `$transaction`, confirmed the test failed, and restored
  it. Without that check I would have been shipping a test that might have passed vacuously.
- **The type checker and linter caught real mistakes.** `tsc` rejected my first attempt at the
  atomicity test stub because the callback did not return a `Promise`. I fixed the harness rather
  than loosening the type.
- **I found and fixed a mistake in my own generated code during diff review:** an exported
  `isTerminal` helper that nothing used, because `canTransition` already covers terminal states via
  empty transition lists. I deleted it rather than leave dead code.
- **My first atomicity test was wrong and passed for the wrong reason.** It stubbed the top-level
  client, but Prisma passes its own transaction client to the callback, so the stub was never
  consulted and the test reported 202 instead of 500. I rewrote it to inject the failure into the
  transaction client itself. A model-suggested test that passes is not the same as a test that
  proves something.
- **I verified the lockfile.** Adding a workspace dependency changed `pnpm-lock.yaml`, and CI runs
  `--frozen-lockfile`; I confirmed a frozen install succeeds rather than assuming it.
- **End-to-end by hand.** I ran the API, worker, and web app together and exercised the README's own
  curl command, the duplicate and stale paths, cross-customer reads, and the retry/dead-letter
  lifecycle.

## Where I overrode the tooling

- The model's initial instinct was to add a `migrations/` directory. I rejected that: the repository
  has never had one, and inventing a migration history would misrepresent the project's state. The
  gap is documented in `DESIGN.md` and `PLAN.md` instead.
- I kept the exercise's polling worker rather than accepting a suggestion to replace it with a queue.
  Correctness within the existing shape was the task; a rewrite would have been scope creep.
- I declined to "fix" the failing baseline worker test by relaxing its assertion. The only change
  was adding the new `deadLettered` field to the expected object; every original assertion still
  holds.
