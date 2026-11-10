# Guarded Agent Workflow

An agent is given a single tool that fronts an XState actor. The agent sees only the transitions enabled from the actor's current state and can only move on by sending a correctly shaped event. All vocabulary is XState's own; this glossary records only the meanings this project adds. Carried over from xstate-api, which proved the approach; the terms under **Authoring** are Backseat's own.

"Workflow" is the outward word, for what people and agents read: the site, the package description, a machine's own instructions and the tool's messages. In technical prose the unit an agent drives is a **machine**, and what is authored is that machine's **definition**: one TypeScript value.

## Language
**Description**:
The XState `description` on a state node or transition, kept short and read while the agent is choosing its next move. On a target it says what the state is once reached; on a transition it says why an agent would take it.
_Avoid_: Purpose, reason, rationale, instructions

**Instructions**:
What a state node or transition hands the agent **by being reached**: what to do now that it is here, relevant only now that it is. Never read while the agent is choosing where to go — that is a description's job — so it is the one thing an agent cannot see before committing to the move. Written as a string, or as a function told the context and which arrival this is — never as an object; a shorter reminder for later visits is something the function says, not a second field. May name an act the driver performs with its own tools rather than a command the project provides ([ADR-0009](./docs/adr/0009-the-workflow-asks-for-a-search-it-does-not-provide.md)); what the driver must send back is still wholly specified, what it used to get there is not.
_Avoid_: Description, prompt, help text, brief

**Usage response**:
What the tool returns when called with no arguments: the machines it fronts and the commands it takes. The pre-actor surface — the only thing an agent reads before any actor exists, and so how to start rather than how to drive.
_Avoid_: Brief, help text, usage text

**Drive protocol**:
How to drive the tool: rules of the tool itself, true of every machine and every state. Delivered once per actor, on the first response its driver receives, because a driver handed a child never reaches the usage response. Never says that any particular child must be driven — that is a **handoff**, and the author's to write.
_Avoid_: Brief, protocol paragraph, preamble, house rules

**Arrival**:
The response a driver receives on landing in a state: that state's instructions, its data and its enabled transitions grouped by target. Every send that moves the actor ends in one; a rejected event repeats the current one unchanged. Which arrival this is — first visit or return — is what an instructions function is told.
_Avoid_: Output (XState's word), screen, turn, "agent sees"

**Schema**:
A zod schema declared on a state node or transition, or a function of context returning one, describing the event payload required to enter that state or take that transition. One side of a contract, never the whole of it.
_Avoid_: Shape, requirements

**Contract**:
The whole shape the agent must send to take one transition: the target state's schema extended with the transition's, as the runtime merges them.
_Avoid_: Merged schema, payload type, combined shape

**Checkpoint**:
A transition that writes nothing down: no action, no assign, nothing kept. Its whole work is the contract — it confirms the agent holds what the next stretch of the machine needs, and hands back that stretch's instructions. Not a transition missing its action: the machine supplies position and refusal, and a checkpoint is position, taken under a validated contract. An agent that cannot state what it has does not move on.
_Avoid_: No-op transition, empty transition, pass-through, stub

**Data**:
The value a state node declares it computes from context, for the runtime to return while the agent is in that state. One of the two declared ways a value in context reaches an agent — the other is a spawn's **about** — and everything else in context stays hidden. How a value one driver stated reaches another driver. On the one response to a send it is also handed that send's event, with the **effect output** on it, so what a call returned is shown once and never kept.
_Avoid_: Revealed context, exposed context, public context, projection

**Driver**:
The agent driving a given actor. A lead and its workers may have different drivers, each with its own context. The tool is the only medium they share: even a finding nothing can verify reaches another driver through a file the machine writes from the payload it validated, never by relay between drivers.
_Avoid_: Caller, operator, user

**Enabled transition**:
A transition from the actor's current state whose guard currently passes and which the agent is permitted to take. The only transitions the agent is shown, grouped by target.
_Avoid_: Next step, move, option, available action

**Target**:
The state node an enabled transition enters, as named by the machine author. The unit the agent is shown: each target lists the event and schema needed to reach it.
_Avoid_: Destination, next state, node

**Offered**:
What the agent is shown from a state: its enabled transitions, grouped by target, each with the event and schema needed to take it. After an actor's first response in a state, a move already shown there whole is named alone until its text changes (ADR-0016). A definition shows every transition a state can offer, with the condition under which it is; only the runtime knows which are offered at a given moment.
_Avoid_: Available, options, the tool's list

**Blocked transition**:
A transition defined on the current state whose guard currently fails. Never shown to the agent.
_Avoid_: Disabled, unavailable

**Contest**:
The transitions one state has for one event under one key, checked in the order they are written; the first whose guard passes is taken, and only that one is offered. If none passes, the event is not dropped: it goes to the state's ancestors.
_Avoid_: Branch, choice

**Inherited transition**:
A transition an ancestor state defines that a nested state can also be moved by, taken only when nothing at the state itself takes the event. It leaves the nested state as surely as one written on it, and the agent is offered it without being told where it came from.
_Avoid_: High-level transition, group transition (UML's names, said from the ancestor's side), inter-level transition (a transition crossing state borders), arena

**Rejected event**:
An event the agent sent that the tool refused: it was not on an enabled transition, its payload failed schema validation, every guard in its contest failed, a spawn site it collects still has a pending child, its effect or an action refused it as it ran and said what to do instead, its effect or an action threw, or the actor had already finished or failed. The actor does not move.
_Avoid_: Failed transition, error event

**Root actor**:
An actor an agent created directly rather than one a machine spawned; the top of an actor tree. Its children carry its id as a prefix. The live-run notes call a root actor a *lead* and its children *workers*.
_Avoid_: Parent (that names any actor with children), top-level actor, lead (informal)

**Run**:
The record of one run directory: its root actor's snapshots and its trace, from the root's creation to wherever it last stopped. A run is live until its root actor reaches a final state or errors, then completed; a run whose driver walked away stays live. One root actor per run unless the harness has named a directory as the run, in which case it may hold several.
_Avoid_: Session, execution, job

**Run directory**:
Where a run's record lives: its snapshots, its trace and, while the run is live, its pin. Moves from live to completed when the run completes. Holds the record and nothing else; what a machine writes for a driver goes to the scratch directory.
_Avoid_: State directory, run folder

**Pin**:
The machines' code as a run's first call loaded it, kept in the run directory and served to every later call, so a definition cannot change under a live actor. Shed when the run completes.
_Avoid_: Snapshot (that names an actor's persisted state), lock, cache; "pinned" for a directory the harness names as the run

**Scratch directory**:
One run's place for couriers, beside its run directory rather than inside it: made when the root actor is created, removed when the run completes. The only place a machine writes a file.
_Avoid_: Plugin directory, temp directory, workspace

**Courier**:
A file a machine writes into the scratch directory for another driver to read — a worker's findings for its lead. Never the only copy of anything the record needs, and meant to be lost when the run completes.
_Avoid_: Finding (the lint's word), artifact, output

**Call**:
One invocation of the agent-facing tool against a run: its arguments, its exit code and the response it printed. Every call is its own process; nothing runs between calls, and the trace records each one.
_Avoid_: Request, invocation, command (that names what a call runs)

**Trace**:
The tool's own log of every invocation against a run directory: each call's arguments, its exit code, and the response it printed. Written by the runtime, never by an agent. Records that a call happened, the payload a `send` supplied (stdin included), and what came back.
_Avoid_: Log, audit log, history, transcript

**Journey**:
One actor's part of a run: the states it came to rest in, in order, with the calls answered from each and the event that moved it on. A record of what one actor did, never a claim about the machine; no journey is the machine's main path, and the project names none.
_Avoid_: Main path, happy path, route, variant, walk

**Step**:
One transition an actor took: the state it was listed on, the event it was listed under, and where it went. A step that goes nowhere ran its actions and left the actor where it was, and a journey's stops are the states it rested in, never its steps.
_Avoid_: Microstep, hop, edge

**Version**:
The code a run is pinned to, named by a digest of its pin and recorded once on the root actor. A run is never driven across an edit, so it has exactly one version, and the version outlives the pin: a completed run still says which code it ran.
_Avoid_: Revision, snapshot, generation

**Output**:
XState's machine `output`, produced when an actor reaches a final state. Machine-to-machine only: it rides the done event to the actor's parent and is never returned to the agent, whose driver already stated everything it contains. A parent that needs part of it for its own driver exposes that part as data. Said bare, it means an actor's; what an effect returned is an **effect output**.
_Avoid_: Result, return value, response

**Effect**:
The tool call a transition exists to make — a read or a write the machine owns — run inside the call that sends its event, after every check has passed and before the machine sees the event. It may refuse the event; the actor then does not move. Its writes are not undone if an action later refuses. Only on an event an agent sends.
_Avoid_: Side effect, invoke, tool call (that names the act, not the key), hook

**Effect output**:
What an effect returned, carried on the event as `output`: to the transition's actions, which keep what must outlive the call, and to the landing state's data, which shows it once. Declared on the event type; never supplied by the agent, never seen by a guard.
_Avoid_: Result, response, return value

**About**:
What a parent records about one child when it spawns it, computed from the parent's context: returned once, to the parent's driver on the spawning call, and carried into the collection. Never shown to the child. A declared reveal like data, but from a parent's context to its own driver; distinct from output, which the child produces.
_Avoid_: Assignment, note, label

**Registration**:
The check every machine an agent can be handed passes before any of them reaches an agent. Made when a machine is built, so a machine that builds is a machine that registers, and made again by the runtime over every machine the catalog record names and, transitively, the ones those spawn. Its boundary is agent-facing, not configured. A machine that fails it stops the process.
_Avoid_: Validation, startup check, startup pass, the machine list

**Spawn-only machine**:
A machine no agent can create, reached only by being spawned by another. Nothing says so: it is simply absent from the catalog record, and reached through a parent's roster. Invisible in the catalog and driven through the same tool surface as any other, so registration covers it.
_Avoid_: Child machine, worker machine, unregistered machine

**Spawn site**:
A state node together with one machine it spawns, whether the definition spawns it or the state's own actions do. What a transition can require settled, and what the runtime files each child under.
_Avoid_: Spawn point, origin, join

**Settled**:
A child that is no longer running: finished, failed or stopped alike. How it ended is kept — its output or its error is what the collection carries — and the runtime stops it once collected, so its parent stops listing it.
_Avoid_: Done, complete, joined, resolved

**Pending**:
A child spawned at a site and still running. The tool names one to the agent as a subagent that has not finished its workflow, by id, when the agent sends a collecting event early.
_Avoid_: Running, in flight, outstanding, unsettled

**Collection**:
What a transition takes from a spawn site it collects: every child that settled there, each with its output or its error, handed as one aggregate to the actions the collecting transition names. Taken when the agent sends the gated event, never when a child finishes. Being collected does not clear it, so two transitions waiting on one site both see it; the next spawn at that site after a collection does.
_Avoid_: Harvest, join, reap, drain

**Passive move**:
An actor changing state or context during a call that did not name it — a parent a child's completion moved while its own driver was away. No definition can author one: nothing reaches a parent until it asks, either directly or by being refused.
_Avoid_: Automatic transition, background advance, push, notification

**Project**:
A `package.json` with a `cli.ts` beside it that names the catalog module. The nearest `package.json` above that module names the project, and the module's default export is the catalog: the machines an agent may create. Node runs `cli.ts`: `--drive`, the agent's tool, and without it, a person's. A run records the project's name and its catalog's URL, and a call from another project's `cli.ts` is refused rather than driven against the wrong catalog. Runs are found, never listed; machines are registered, never found.
_Avoid_: Workspace, package, app

**Catalog**:
The machines an agent can create: the ones named in the record the project's catalog module exports, each under the name that record gives it — never the machine's `id`. What the usage response lists.
_Avoid_: Machine list, registry (that names the live actors), manifest, config, the definitions found

**Progressive disclosure**:
Showing an agent only what it needs for its current decision — enabled transitions from the current state, a schema and full instructions only the first time they're needed, one queue item at a time — and nothing about the rest of the machine until it gets there. Applies to any surface fronting an actor for an agent, not just the tool itself.
_Avoid_: Lazy loading, on-demand disclosure

## Authoring

**Definition**:
The one TypeScript value that describes a machine, handed to Backseat's own `createMachine`: an XState machine config carrying Backseat's keys — instructions, data, schema, the roster — first-class on the value, with every action, guard, schema and data projection written in place as a value. What a state spawns and what a transition collects are said by the actions that do it, never by a key, and the sample input registration builds it with rides on the context initializer. Nothing else is authored: no file beside it, no name that stands for something elsewhere, no build step. `meta` is where `createMachine` puts Backseat's keys for the runtime to read, beside the author's own; the keys it puts there are never written under `meta` by hand.
_Avoid_: Config, machine JSON, definition file, workflow, XState config, meta

**Roster**:
The machines a definition can reach, each under the name its spawns and collections use. The one place in a definition where a name stands in for a value, because the runtime files a spawned child under its site by that name.
_Avoid_: Actors map, children, implementations, registry

**Handoff**:
What a parent's instructions tell its driver to do with the subagents a response has just listed: start one for each and give it the command listed for it, then wait until all are complete. Written by the author, never by the runtime, which lists each subagent with its purpose and its first command but never says that one must be started. Names no command, since the runtime lists it. A machine that spawns and omits it hangs: its children are never driven, so nothing settles.
_Avoid_: Delegation, dispatch instructions, the protocol

**Demo**:
A project under `demos/` that consumes Backseat as an installed package and proves one claim its README states. A recorded run is optional. A project that only compiles is a fixture, not a demo.
_Avoid_: Example, sample, fixture, showcase

**Trace report**:
The rendered page for one trace, generated when a human asks for it from any trace the tool can find.
_Avoid_: Post-run report, trace page, run report
