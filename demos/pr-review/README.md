# pr-review

One machine, one actor, no spawning: it works a pull request to a verified close and
**will not let an agent close over a failing check**.

The claim it proves: **a machine supplies position and refusal, nothing else.** Everything
this machine knows about the pull request — the diff, the tests, the checks — reached it
because the agent sent it, under
[ADR-0009](../../docs/adr/0009-the-workflow-asks-for-a-search-it-does-not-provide.md). The
machine has no network and no shell. What it contributes is which round this is and which
moves are not available from here.

`validating` → `triaging` → `building` → `reviewing` → `complete`, with `reviewing`
returning to `building` while concerns remain and rounds are left, `triage.clean` as the
ending from `triaging` for a pull request that needs nothing, `review.exhausted` at the
round bound, and `blocked` as the way out from `triaging`, `building` or `reviewing` when
what is wrong cannot be fixed from here. There is no planning state between naming a gap
and fixing it: a gap is named concretely enough to act on, and a plan the machine could not
read back would only have restated it. What the agent builds reaches the pull request as
suggestions on the lines it changed, never as a commit — and as a patch in the summary
where the change falls outside the diff, since a suggestion cannot be attached there.

Two ways it refuses, and they are different ways on purpose:

- **Schemas are the audit.** Where a step has to have actually happened, the schema demands
  the artefact only doing it produces — `changedFiles` on `pr.verified`, a per-check
  `output` on `build.submit`, a non-empty `reviewed` on every way out of `reviewing` and on
  `triage.clean`, and on `triage.clean`, the one path that approves, the checks run and green
  as well. A claim
  with nothing in it is refused as `invalid-payload`. This cannot tell a true count from an
  invented one and does not pretend to; it raises the floor on lying from free to deliberate.
  One schema is derived from context: `build.submit` names every check triage or an earlier
  round has reported, and refuses a round that leaves one out, saying which — so a later
  round cannot drop a red check and close green without it, and since the suite triage ran
  seeds that list, neither can a run close green over a suite nobody re-ran after the
  changes. An agent that could not make the fix at all does not send an empty round through
  review; it leaves by `build.blocked` with what stopped it.
- **The one thing the machine knows is refused, not asked.** Whether the last round's checks
  passed is already in context, because the agent reported it. So `checksPassed` is a
  **guard**: when the last round is red, `review.clear` is not listed at all and the only way
  on is another round.

`deep-research` exercises the spawn-and-collect half of the surface heavily; this machine
touches none of it — no roster, no `spawnChild`, no `collectChildren`, no compound or
parallel states. That is the measurement: a surface is unwieldy if the parts you are not
using still cost you.

## Running it

```sh
pnpm install && pnpm build          # from the repo root
cd demos/pr-review
pnpm typecheck
node cli.ts --drive                  # the catalog
node cli.ts --drive create pr-review
```
