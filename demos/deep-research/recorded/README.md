# Recorded runs

Real runs of this demo, kept whole. Each directory holds the pinned run (`state/`: the root's record, `trace.jsonl`
and the rendered `trace.html`) and, under `calls/`, the response of every call **as the driver saw it**, one file per
call in the order the calls started, headed by the exact command, the stdin payload if any, and the exit code. The
runtime persists the structured response, not the rendered text, so `calls/` is captured by [`drive`](./drive), the
wrapper a driver is handed in place of `node cli.ts --drive`: it runs that command from the demo directory with
`BACKSEAT_STATE_DIR` pinned under the run and copies stdout; nothing the driver saw differs from what the command
prints. It records into `1/` unless `RECORD_DIR` names another directory.

What a run holds of third parties is the driver's own queries and summaries and `{url, title}` citations.
`search.results` carries only the query; hits never enter the record.

## 1: the Branson question

- **Question:** *Where is the best place to take my kids fishing in Branson, MO?*
- **Driven** 2026-11-07 by a fresh Claude Sonnet 5.5 agent given only the driver prompt (no repo access, learn the tool from
  the tool), searching with its own web search and fetch. It spawned one subagent per worker. This is the sixth
  recording of the question. The first predates descriptions being marked and the demo's instructions naming no event.
  The second predates the state descriptions saying what the state is. The third predates the budget riding
  `brief.submit` into `planning`'s data, the demo dispatching and collecting on two named events, and the
  `## Subagents to start` announcement. The fourth predates 0.1.0's public surface, where `node cli.ts --drive` is the
  one way to run the tool. The fifth, on that surface, was discarded unkept: its driver had the means to spawn
  subagents but drove all seven workers itself, judging a subagent not worth the overhead for a bare order. So the
  dispatch order now carries its reason, that each worker's searches and pages stay out of the lead's context and the
  workers run side by side. Each recording replaced the last whole.
- **Record:** 72 calls over 3m02s, root `1b36b700-73f1-4497-80fd-993bb42a624f`, status `done`. 12 sub-tasks proposed,
  6 picked and run, 6 collected with findings. 2 `task.next` sends not offered, 1 call naming an actor that does not
  exist, 0 refusals, 0 schema rejections. Print the delivered report with
  `BACKSEAT_STATE_DIR=$PWD/recorded/1/state npx backseat-ai output 1b36b700-73f1-4497-80fd-993bb42a624f`: 255 words,
  6 citations.

Where the moments are:

| Moment | Calls |
| --- | --- |
| Usage, then the first arrival with instructions and open moves | `001` (`--help`), `002` |
| The budget judged from the question, shown once on the arrival that answers `brief.submit` | `003` |
| A move shown whole once, then named alone with "call describe" | `004` (whole) → `005`, `007`–`009` (named alone); every later response in a state |
| `describe` re-showing one move's schema | `026` (`search.results`), `061` (`finding.submit`), each from a worker's subagent |
| Subagents to start: each announced with its `about` and its first command | `004` (first, on `plan.submit`), `005`, `007`–`010` |
| `snapshot` of a running actor: each worker's first arrival, as its subagent orients | `014`–`018`; `task-1-1`'s came from the lead's own driver (`006`), whose subagent reoriented on `025` |
| An actor that does not exist (exit 1) | `019`: a subagent ran `snapshot <root>/task-1-N` literally, then took its own id |
| Workers: queries, one `search.results` per query, the finding | `013`, `020`–`047`, `049`–`052`, `054`, `055`, `057`, `065` |
| An event that is not offered, rejected | `011`, `012`: `task.next` sent twice more after the last sub-task was dispatched |
| A finding refused mid-move, a cited source gone | not in run 1 |
| A stated absence instead of a finding (`finding.empty`) | not in run 1 |
| The lead polled with `snapshot` while its workers ran | `048`, `053`, `056`, `060`, `062`, `063`, `066`–`068` |
| The collecting move refused while workers are pending | not in run 1: this driver polled with `snapshot`, which is never refused |
| The collecting move taken; review, conclusion, draft, citations accepted | `069`–`072` |

What the run exposed:

- With the dispatch order giving its reason, the driver spawned six subagents, one per worker, and they ran side by
  side: their calls interleave within the same seconds (`020`–`047`). One recording each way is not a rate; it shows
  the bare order could be set aside and the reasoned one was not.
- A worker's subagent called `describe` for the first time in any recording, twice (`026`, `061`): once for
  `search.results`, whose schema is only `query`, and once for `finding.submit` before sending it.
- A subagent read the placeholder in its own prompt literally (`019`, `task-1-N`), was told the actor is unknown, and
  corrected itself. The lead's driver had written that placeholder; the tool's own announcement names each id.
- The driver dispatched with a burst of `task.next`, two past the last offered sub-task (`011`, `012`); each refusal
  said the actor had not moved and that nothing is offered until the subagents finish.
- The driver waited with a polling loop on `snapshot` (nine polls of the lead), so no pending refusal is in this run.
- No finding cited a gone page, and no worker came back empty, so neither the source refusal nor `finding.empty` is in
  this run.
- The lead concluded after one round of a four-round budget and drafted from its subagents' hand-backs without
  reading a finding file; by its own account most findings rest on search snippets.
- Every payload went on stdin (`-`). No payload was rejected by a schema.
