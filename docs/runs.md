# Where a run lives

A **run** is one root actor's directory. It holds the root's record, the trace of every call made against it, and,
while the run is live, the pin of the code it started with. Nothing runs between calls, so every call finds its run
from the actor id it's given, acts, and writes back
([ADR-0006](./adr/0006-a-run-is-a-private-per-user-directory.md)). This page covers where runs live, what each file in
one holds, and the commands that read them. How an agent drives an actor is in [`driving.md`](./driving.md), and the
full command reference is in [`cli.md`](./cli.md).

## Where runs live

A run is **live** until its root actor reaches a final state or errors, and **completed** after. The two are kept in
different places, and each run is a directory named for its root actor's id:

| What | Default |
| --- | --- |
| Live runs | `$XDG_STATE_HOME/backseat/runs`, or `~/.local/state/backseat/runs` when `XDG_STATE_HOME` is unset |
| Completed runs | `<tmpdir>/backseat-<uid>/runs` |
| A run's scratch directory | `<tmpdir>/backseat-<uid>/scratch/<root id>` |

`<tmpdir>` is Node's `os.tmpdir()`, which reads `TMPDIR`. `<uid>` is your user id, or your username on a platform
without one. Live runs go under the state home because nothing purges it mid-run. A completed run goes to the temp
directory, where the OS may reclaim it, and that loses the only copy of its trace. Copy out a run you want to keep.

Calls that touch no actor, such as the usage response or a call naming an actor no run holds, are traced into a
**run-less** `trace.jsonl` that sits directly in the live directory, beside the runs.

### A directory another user owns

The default directories are yours alone. `$XDG_STATE_HOME/backseat` and `<tmpdir>/backseat-<uid>` are made with mode
`0700`, because a run's files hold full payloads and the source of the code it ran. One that another user already owns
is refused, not written into:

```ts packages/backseat-ai/src/runtime/run.ts
`${dir} belongs to another user, who could read a run's files there; set TMPDIR and XDG_STATE_HOME to directories of your own`
```

The completed directory carries your uid in its name for the same reason. A shared `/tmp/backseat` would belong to
whoever made it first, and everyone else's runs would be written where that user could read them. A directory you name
in [`config.json`](#configjson) is used as given, without this check.

### `config.json`

`$XDG_CONFIG_HOME/backseat/config.json`, or `~/.config/backseat/config.json` when `XDG_CONFIG_HOME` is unset, moves
either location:

```ts packages/backseat-ai/src/runtime/runs.ts
export type UserConfig = { runs?: { live?: string; completed?: string } }
```

So `{ "runs": { "completed": "~/backseat/completed" } }` keeps completed runs out of the temp directory.

- **`~` is your home directory.** A relative path is read from the config file's directory, so a checked-in config
  stays portable. An absolute path is used as written.
- **A key left out keeps its default**, and so does every key when there's no file. A file that isn't valid JSON is an
  error, not a fallback to the defaults.
- **It's yours, never the project's.** No project file moves runs: where a person keeps their runs is theirs.

### Environment variables

| Variable | What it changes |
| --- | --- |
| `BACKSEAT_STATE_DIR` | Pins one directory as the run, in place of the live and completed directories. See below. |
| `XDG_STATE_HOME` | Where live runs go: `$XDG_STATE_HOME/backseat/runs`. |
| `XDG_CONFIG_HOME` | Where `config.json` is read from: `$XDG_CONFIG_HOME/backseat/config.json`. |
| `TMPDIR` | Where completed runs and scratch directories go, through `os.tmpdir()`. |
| `BROWSER` | The command [`report`](#report) opens its page with. `none` opens nothing. |
| `CI` | When set, `report` opens nothing. |

**`BACKSEAT_STATE_DIR` is for a harness.** Every actor id then resolves to that one directory, so it may hold several
roots, and it never moves to completed. The run-less calls land in its trace too. Each root there has its own pin, and
one that finishes sheds its pin and its scratch directory, leaving the other roots' alone. `report` lists the pinned
directory beside the configured runs, and `doctor` never proposes removing it. The recorded deep-research run was made
this way, so its trace opens with the `--help` call its driver made before `create`.

## The files in a run

| File | What it is | When it's there |
| --- | --- | --- |
| [`<root id>.json`](#the-roots-record) | The root's record | From `create` on, rewritten by every call on its actors |
| [`trace.jsonl`](#the-trace) | The trace | From the first call on, one line per call |
| [`<root id>.pin.json`](#the-pin) | The root's pin | From `create` until the root finishes |
| `<root id>.lock`, `trace.lock` | Locks | While a call holds the root, and while a trace line is appended |
| `trace.html` | The trace report | Once [`report`](#report) has rendered the run |

That's everything. What a machine writes for another driver to read goes to the
[scratch directory](#currentrun-and-scratchdir), which is a sibling of the run, not part of it. The recorded
deep-research run, completed, holds `1b36b700-73f1-4497-80fd-993bb42a624f.json`, `trace.jsonl` and `trace.html`.

### The root's record

One JSON file per root actor holds the whole actor tree. A child is persisted inside its root's snapshot, never in a
file of its own. The file is written through a rename, so a reader never sees a torn record.

```ts packages/backseat-ai/src/runtime/registry.ts
export type StoredActor = { machine: string; snapshot: Snapshot<unknown>; sites?: SiteRecord; collected?: KeptRecord; version?: string; scratch?: string; bin?: string; project?: string; catalog?: string }
```

- **`machine`** is the catalog name the root was created under.
- **`snapshot`** is XState's persisted snapshot, with every child inside it. Its `status` is the run's: `active`, `done`
  or `error`.
- **`sites`** is every child the tree has seen, by the qualified id of the actor it belongs to and then the child's
  key: the state whose spawn site it was filed under, the machine it is, its [`about`](./subagents.md#about), and
  whether it was collected.
- **`collected`** is what each collection copied out of a child before stopping it. A stopped child is gone from the
  snapshot's `children`, so this is the only copy of what it returned
  ([ADR-0008](./adr/0008-an-actor-never-changes-under-its-driver.md)). [`output`](#output) reads it, and so does whoever
  assesses the run. No agent does.
- **`version`** is the digest of the pin. It stays after the pin is shed, so a completed run still says which code it
  ran.
- **`scratch`** is the run's scratch directory, recorded because `tmpdir()` differs by platform and environment.
- **`bin`**, **`project`** and **`catalog`** are the tool that created the root, the project's name, and the URL of the
  catalog module `create` imported. The catalog is what keeps the run [with its project](#a-run-belongs-to-its-project).

The recorded run's record ends:

```json demos/deep-research/recorded/1/state/1b36b700-73f1-4497-80fd-993bb42a624f.json
"version":"c209c4322a03","bin":"node cli.ts --drive","project":"deep-research"
```

### The trace

`trace.jsonl` holds one JSON line per call, appended under its own lock so two calls finishing at once can't interleave.
It records what the agent did and what it was shown, never XState's internal traffic. The runtime writes it, never an
agent.

```ts packages/backseat-ai/src/runtime/trace.ts
export type TraceEntry = {
  /** When the call began, ISO 8601. */
  at: string
  /** Wall time in ms. */
  ms: number
  /**
   * `create`/`send` only: every actor this call moved, with the transitions each took. Harness-facing, never in the
   * response the agent reads: the state an actor rests in cannot tell two guarded transitions to one target apart, show a state passed straight through, or show a
   * transition that acted without moving at all.
   */
  moved?: Moved[]
  /** `create`/`send` only, when any: a child that appeared which no spawn site declares, one line each. */
  warnings?: string[]
  /**
   * `send` only, when the taken transition's effect ran: what it returned, in full, where the response shows only what
   * `data` chose to. Beside a rejection it records an effect that ran for a transition that was then discarded.
   */
  effect?: { output: unknown }
  pid: number
  argv: string[]
  /**
   * `send` only: the payload as the runtime received it, whatever its origin. `argv` alone cannot say, because the
   * stdin form the drive protocol teaches leaves only `-` there.
   */
  payload?: Record<string, unknown>
  /** The actor the call touched: the argument for actor commands, the new id for `create`. */
  actorId?: string
  exitCode: 0 | 1 | 2
  /** Exactly what was printed: the response on 0 and 2, the `{ error }` on 1, `{ error, usage }` for a usage error. */
  response: unknown
}
```

`response` is the structured response, not the text the driver read. Each `moved` entry is an actor, the state it's in
now, and its **steps**: the transitions it took, in the order XState fired them. A step names the state it's listed on,
its event (`always` for an eventless one), its guard, and where it went. A step with no `to` ran its actions and left
the actor where it was.

When two regions of a parallel state both leave it on one event, XState takes only the first, and the trace records
only that one. The exception is when the transition XState took entered the other's target anyway: both regions going
to the same state, or one to a state inside the other's target. Then both steps are recorded.

This call took a guarded self-transition and spawned one more worker:

```json demos/deep-research/recorded/1/state/trace.jsonl
{"at":"2026-11-07T19:23:43.934Z","ms":8,"pid":77453,"argv":["send","1b36b700-73f1-4497-80fd-993bb42a624f","task.next"],"exitCode":0,"response":{"actorId":"1b36b700-73f1-4497-80fd-993bb42a624f","status":"active","state":[{"id":"researching","instructions":"Dispatch while another sub-task is offered; otherwise wait until all of your subagents are complete, then move to review."}],"targets":[],"awaiting":true,"children":[{"id":"1b36b700-73f1-4497-80fd-993bb42a624f/task-1-6","about":"What do reviews on TripAdvisor, Yelp and travel blogs say about the best places for kids to fish in Branson, MO? Cover only review opinions and rankings."}]},"actorId":"1b36b700-73f1-4497-80fd-993bb42a624f","payload":{},"moved":[{"actorId":"1b36b700-73f1-4497-80fd-993bb42a624f","state":["researching"],"steps":[{"from":"researching","event":"task.next","guard":"hasPending","to":["researching"]}]}]}
```

A guard is recorded by its function's name. An inline arrow written at `guard:` is named `guard` by JavaScript, which
tells nothing apart, so it's recorded with no name. Hoist a guard to a named const to see it in the trace.

A call that failed records the error it printed, on exit 1:

```json demos/deep-research/recorded/1/state/trace.jsonl
{"at":"2026-11-07T19:24:35.284Z","ms":4,"pid":78109,"argv":["snapshot","1b36b700-73f1-4497-80fd-993bb42a624f/task-1-N"],"exitCode":1,"response":{"error":"Unknown actor '1b36b700-73f1-4497-80fd-993bb42a624f/task-1-N'"},"actorId":"1b36b700-73f1-4497-80fd-993bb42a624f/task-1-N"}
```

Every entry carries its facts rather than pointing at the code, so [`report`](#report) reads `trace.jsonl` and nothing
else. A completed run stays readable after the code that ran it has changed, moved or gone.

### The pin

A definition can't change under a live actor, because the run pins the code it started with. `create` captures every
module it loads from the catalog on, and every later `send`, `snapshot` or `describe` on the run is served those
modules from its root's `<root id>.pin.json`, never from disk. An edit, a delete or a rename mid-run has no
effect until a new run.

```ts packages/backseat-ai/src/runtime/pin.ts
/**
 * The code one run started with. `resolved` is every specifier the capture resolved, keyed by the importer and the
 * text written, because a deleted file cannot be resolved again; `modules` is the bytes, keyed by URL.
 */
export type Pin = { resolved: Record<string, string>; modules: Record<string, PinnedModule> }
```

- **An import the pin doesn't hold is refused**, not loaded live. That's a module down a branch `create` never took.
  The error says to start a new run.
- **`backseat-ai` isn't pinned.** It's loaded before the capture starts, so the copy installed now is the one that
  runs. The runtime isn't the definition.
- **A corrupt pin refuses every call** on the run, since running live would defeat it.
- **A completed run has no pin.** Its record keeps the `version`, and a later call on it runs the current code.

### Locks

A call on an actor holds `<root id>.lock` for the whole call, so calls on one run take turns, children driven in
parallel included. The lock records its owner's pid. A waiter takes it over only when that process is dead, or, with no
pid to read, when the lock is more than 30 seconds old. The holder refreshes it every 5 seconds, so a long effect is
never judged stale, and a waiter gives up after 3 minutes
([ADR-0014](./adr/0014-a-live-owners-lock-is-never-stale.md)).

## When a run completes

The call that leaves the root's record `done` or `error`, once its trace line has landed:

1. sheds the root's `<root id>.pin.json`;
2. removes the run's scratch directory;
3. moves the run directory from live to completed. A pinned run stays where it is.

What's left is the record and the trace, which is all a completed run needs. A run whose driver walked away is never
completed, and stays live until [`doctor`](#doctor) proposes removing it.

## A run belongs to its project

The record names the catalog that created the root. A `send`, `snapshot` or `describe` on that root from a project's
`cli.ts` that names another catalog is refused before that catalog is imported:

```ts packages/backseat-ai/src/cli/agent.ts
throw new Error(`Actor '${rootId}' was created from ${fileURLToPath(record.catalog)}, not ${display(project.machines)}; drive it from ${record.project ?? 'that project'}`)
```

Live runs from every project share one directory, keyed by root id alone. Without the refusal, another project would
rehydrate the root against whichever of its own machines shares the name
([ADR-0012](./adr/0012-the-project-cli-names-the-catalog.md)). The refusal is printed to stderr with exit 1. It comes
before the tool is built, so it isn't traced.

## `currentRun` and `scratchDir`

A machine's own actions and effects are plain functions, with no other way to learn which run they're in. Both are
exported from `backseat-ai`.

```ts packages/backseat-ai/src/runtime/run.ts
/** The run a call is acting in: its root actor's id and the directory that is the run (ADR-0006). */
export type CurrentRun = { id: string; dir: string }
```

**`currentRun()`** is the run this call is acting in, set once per call before anything runs. The id is the root's
even when the call is on a child. Outside a call on an actor it throws:

```ts packages/backseat-ai/src/runtime/run.ts
if (!current) throw new Error('no current run: currentRun() is only meaningful inside a call on an actor')
```

That includes building the machine. `createMachine` runs `data` against the initial context, outside any call, so a
`data` that reaches `currentRun()` or `scratchDir()` from that context fails the build.

**`scratchDir(runId?)`** is the run's scratch directory, `<tmpdir>/backseat-<uid>/scratch/<root id>`. Without an
argument it's the current run's. It's made at `create` and removed when the run completes, so a path into it is good
exactly as long as the run is live. It's the one place a machine writes a file. A file there is a **courier**, for
another driver to read: never the only copy of anything the record needs, and meant to be lost. The deep-research lead
names each worker's finding file after the worker's key:

```ts demos/deep-research/deep-research.ts
const findingFile = (actorId: string) => join(scratchDir(), `${actorId.split('/').pop()}.md`)
```

It calls that only from inside a `data` callback that maps over collected findings, which the empty initial context
never enters.

## Reading a run

`report`, `output` and `doctor` belong to the `backseat-ai` bin: `npx backseat-ai <command>`. They read the run store
and no catalog, so any copy of Backseat runs them the same, and none is on the agent's tool. The flags are in
[`cli.md`](./cli.md).

### `report`

Renders a run's trace as a page. `report [<root id prefix> | <dir>] [--no-open]`:

- **With nothing**, it lists every run it can find, live, completed and pinned, by last call, newest first. On a
  terminal, it then asks which run to render. Anywhere else it stops at the list.
- **With a prefix**, it renders the one run whose root id starts with it. A prefix matching more than one run is an
  error.
- **With a path**, it renders that directory, or the directory of the file named. It doesn't need to be a run the tool
  would find.

The list has a row for each root, so a pinned directory with two roots shows both:

```ts packages/backseat-ai/src/cli/human.ts
const COLUMNS = ['#', 'machine', 'root', 'status', 'started', 'last call', 'calls', 'undeclared', 'where'] as const
```

A root that's still `active` reads `not finished`. `undeclared` counts children that appeared which no spawn site
declares, so a run says what its definition failed to name.

It writes `trace.html` into the run directory, prints its path and how many calls it holds, and opens it unless
`--no-open`, `BROWSER=none` or `CI` says not to. The page is self-contained: the trace is embedded in it and it loads
nothing. It shows each actor's journey, the states it stopped in with the calls answered from each and the send that
moved it on, and selecting a call shows that exchange whole. A concurrency view plots every actor's calls side by side
in time.

### `output`

Prints a finished actor's `output` as JSON:

```ts packages/backseat-ai/src/runtime/output.ts
export type ActorOutput = { actorId: string; status: 'done'; output: unknown }
```

`output <actorId>` takes the root id or a prefix of it, and a child as `<root>/<key>`. A collected child's output is
read from the record's `collected`. An actor that hasn't finished, or a child collected after it errored or was
stopped, has no output, and saying so is an error.

It's a read. It takes no lock and writes no trace line, so reading a run never lands in its record as a call the run
made. And it's a person's command, or a harness's, never the agent's: the driver already stated everything an output
holds. The recorded run's report prints with
`BACKSEAT_STATE_DIR=$PWD/recorded/1/state npx backseat-ai output 1b36b700-73f1-4497-80fd-993bb42a624f`, from the demo's
directory.

### `doctor`

A live run whose driver walked away stays live forever, since nothing can tell abandonment from a long pause.
`doctor` lists the live runs whose last call is older than this, and counts the run-less calls as old:

```ts packages/backseat-ai/src/cli/human.ts
const STALE_DAYS = 14
```

`doctor --yes` removes them. Removing a run removes its scratch directory too, and the run-less trace is trimmed to the
newer calls. Without `--yes` it asks on a terminal, and anywhere else it says to run again with `--yes`. Completed
runs and a pinned directory are never proposed, and with `BACKSEAT_STATE_DIR` set the run-less calls are left alone,
since they're in the pinned run's own trace.
