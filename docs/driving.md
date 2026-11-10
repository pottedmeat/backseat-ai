# What a driver sees

A driver is the agent driving one actor, and its whole tool is your project's `cli.ts` under `--drive`. Every call is
its own process. It restores the actor from disk, acts, prints one response and exits
([ADR-0003](./adr/0003-cli-rehydrates-per-invocation.md)). This page is that response: what each command prints, in
what order, what it leaves out the second time, and how a refusal reads. What it prints comes from the keys in
[`machines.md`](./machines.md) and [`subagents.md`](./subagents.md), so read those first. Setting a project up is in
[`quickstart.md`](./quickstart.md), every command and flag is in [`cli.md`](./cli.md), and the trace a run keeps of
each call is in [`runs.md`](./runs.md).

Every response below is a call from run 1 of the deep-research demo, as its driver saw it
(`demos/deep-research/recorded/1/calls/`). Each file is headed by the command, any stdin, and the exit code. The
recording wrapper adds that header. The tool prints everything under it.

## The commands

A driver meets four commands, and the usage response is where it meets them. That's what the tool prints with no
command, or with `--help`:

```text demos/deep-research/recorded/1/calls/001.txt
`node cli.ts --drive` fronts these machines:

- **deep-research** — Research a question end to end: decompose it into sub-tasks, dispatch a worker per sub-task, judge whether the answer is complete, then draft and cite a report.

Start one with `node cli.ts --drive create <machine>`.

## Commands

`node cli.ts --drive create <machine>`
Start a fresh actor. The response is its id, its state, and the transitions enabled from there.

`node cli.ts --drive send <actorId> <event.type> ['<json payload>' | -]`
The only way to move an actor. Payload keys follow the schema shown for that event. A - in the payload's place reads the JSON from stdin instead.

`node cli.ts --drive snapshot <actorId>`
Current state and enabled transitions, unchanged. How to orient when handed an id.

`node cli.ts --drive describe <actorId> [<event.type>]`
With an event: that one move — where it leads, what it is for and its schema — and nothing else. Without one: the current state with its full first-arrival instructions, its data and its moves.
```

The machines listed are the project's catalog, each with its root's `description`. A subagent handed a child never sees
this response. It starts from the `snapshot` command it was given, so nothing a driver needs is said only here.

- **`create`** makes a root actor and answers with its first arrival. It's the one call that invents an id, so it's
  the one that names it, on its first line.
- **`send`** is the only call that moves an actor. With no payload, the payload is `{}`. With `-`, the JSON is read from
  stdin, which keeps free text out of the shell.
- **`snapshot`** answers with the arrival the actor is at, and moves nothing. It's never refused.
- **`describe`** answers with one move, or with the whole state as a first arrival would show it. See
  [`describe`](#describe).

## An arrival

Every `create`, `send` and `snapshot` answers with an **arrival**: the state the actor is at, as the driver reads it.
This is `create`'s:

```text demos/deep-research/recorded/1/calls/002.txt
Actor `1b36b700-73f1-4497-80fd-993bb42a624f` is running `deep-research`.

State the research question verbatim as you were given it.

## To move to state: planning (The question is known; this round needs sub-tasks.)

### brief.submit → planning (The question is stated.)

    question: string   // min length 10

## How to drive this tool

Every response tells you what you can send next: the states you can reach from here, and under each the event and the payload that must be sent to reach it. Read each one before the next call, and send only an event it lists. A move shown to you whole is named alone on later responses in the same state, until it changes; `node cli.ts --drive describe <actorId> <event.type>` prints it whole again. Every payload passes through your shell, where a quote or apostrophe in free text will eventually break the call before the tool sees it. Pass `-` in the payload's place and feed the JSON on stdin instead — `node cli.ts --drive send <actorId> <event.type> - <<'JSON'`, with the delimiter quoted exactly as shown — and nothing in it is re-parsed.

---
1b36b700-73f1-4497-80fd-993bb42a624f · at briefing · active
```

A response has up to ten parts, always in this order, and each is left out when it has nothing to say:

1. **The opening line**, on `create` only, naming the actor and its machine.
2. **The transition's `instructions`**, on a `send` whose transition has them. They come before the state's, because
   that's the order the two happened in.
3. **`This actor has errored: <message>. Nothing more can be sent.`**, on an actor that has errored.
4. **The state's `instructions`.** A nested state's follow its parents', and a state with none at all reads
   `You are at <state>.` instead. The state's `description` isn't repeated: the driver chose this state from a
   heading that already carried it.
5. **`This actor is done. Nothing more can be sent.`**, on an actor in a final state.
6. **`## Data`**, the state's [`data`](./machines.md#data), printed as labelled fields.
7. **The moves**, on an active actor. See [the moves](#the-moves).
8. **`## Subagents to start`**, on the call that spawned them ([`subagents.md`](./subagents.md#driving-the-children)).
9. **`## How to drive this tool`**, the drive protocol, on the first response this actor's driver receives.
10. **The footer**: the actor's id, the state it's at, and its status (`active`, `done` or `error`).

Instructions lead because they're the one thing written to be read on arrival. The footer is the only place the
state's name appears. Instructions are written without naming the state, so a machine whose outcome is which final
state it reached still says which one. In a parallel state the footer lists every active state, comma-separated, and a
nested state is named by its path from the root:

```text demos/deep-research/recorded/1/calls/071.txt
1b36b700-73f1-4497-80fd-993bb42a624f · at citing.awaiting · active
```

### The moves

The moves are grouped under the state each one reaches. A `##` heading names that state, with its `description` in
parentheses. Each `###` under it is one event that gets there, with an arrow repeating the destination and the
transition's `description` after it. Under that comes the contract: the target state's [`schema`](./machines.md#schema)
extended with the transition's, as an indented block with each field's constraints in a column of comments.

```text demos/deep-research/recorded/1/calls/003.txt
## To move to state: researching (Workers are being dispatched and are running.)

### plan.submit → researching (The round has its sub-tasks.)

    subTasks: {
      subQuestion: string   // min length 10
    }[]                     // min 10 items, max 40 items
```

Those two heading levels are the whole grammar, so a driver can tell a state from an event by the heading alone. The
`##` says "To move to state:" because a bare state name was read as the state the actor is in
([ADR-0017](./adr/0017-how-a-move-is-printed.md)). An event that takes no payload says `no payload` where the schema
goes, and a move that [collects children](./subagents.md#collectchildren) carries a `Requires:` line:

```text demos/deep-research/recorded/1/calls/067.txt
## To move to state: reviewing (Every worker in this round has reported.)

### research.review → reviewing (Every sub-task is dispatched and every worker is back.)
Requires: every child spawned at researching (researchTask) settled

    no payload
```

Only the moves offered now are listed. A move whose guard fails isn't shown, and neither is a collecting move while
any child it collects is pending ([ADR-0008](./adr/0008-an-actor-never-changes-under-its-driver.md)). When nothing is
offered, the moves block is one line. While a collecting move is held back, the line says the wait is the reason,
without naming the move:

```text demos/deep-research/recorded/1/calls/048.txt
Dispatch while another sub-task is offered; otherwise wait until all of your subagents are complete, then move to review.

No move is offered until your subagents finish their workflows.

---
1b36b700-73f1-4497-80fd-993bb42a624f · at researching · active
```

Otherwise it says `No move is offered from here right now.`

### Data

`## Data` prints one field per key, `- <key>: <type>` with the value under it. On the response to a `send`, `data` is
also handed that send's event, so what it shows from the event is shown once. Here `budget` came from the effect on
`brief.submit`, and a `snapshot` in `planning` wouldn't show it:

```text demos/deep-research/recorded/1/calls/003.txt
## Data

- round: number
1

- maxRounds: number
4

- budget: string
Four rounds at most: the candidates have to be found first, then each examined in turn.
```

### The drive protocol

The drive protocol is the runtime's own paragraph on how to drive the tool, the same for every machine. It reaches
each actor's driver once, on the first response that driver gets for that actor
([ADR-0004](./adr/0004-drive-protocol-on-first-presentation.md)). For a root that's `create`. For a child it's usually
the first `snapshot`, which is why it's printed per actor and not only in the usage response. A worker's subagent never
sees the usage response. The protocol it got on its first `snapshot` is the same paragraph as `002`'s:

```text demos/deep-research/recorded/1/calls/006.txt
## How to drive this tool

Every response tells you what you can send next: the states you can reach from here, and under each the event and the payload that must be sent to reach it. Read each one before the next call, and send only an event it lists. A move shown to you whole is named alone on later responses in the same state, until it changes; `node cli.ts --drive describe <actorId> <event.type>` prints it whole again. Every payload passes through your shell, where a quote or apostrophe in free text will eventually break the call before the tool sees it. Pass `-` in the payload's place and feed the JSON on stdin instead — `node cli.ts --drive send <actorId> <event.type> - <<'JSON'`, with the delimiter quoted exactly as shown — and nothing in it is re-parsed.

---
1b36b700-73f1-4497-80fd-993bb42a624f/task-1-1 · at briefing · active
```

It doesn't say what a rejection looks like, because a rejection says so itself.

## What shortens on repeat

The actor keeps a record of what its driver has been shown, in a slice of context of its own, and later responses
leave out what that record holds. The record belongs to the actor, not the driver, so a new driver handed the same
actor inherits it. `describe` is how that driver sees everything again.

**Instructions switch to the revisit text.** Once a state's instructions have been presented, a later arrival there is a
revisit, and an `instructions` function is told so ([`machines.md`](./machines.md#instructions)). `researching`
re-enters itself on each `task.next`. Its first arrival, on `plan.submit`, gave the long text:

```text demos/deep-research/recorded/1/calls/004.txt
This machine picked which of your proposed sub-tasks run this round, and in what order; those not picked are not run, and you may propose them again in a later round. For each one, spawn a subagent and tell it to run the listed command: each worker's searches and pages then stay out of your context, and the workers run side by side. Keep dispatching while another sub-task is offered, then wait until all of your subagents are complete before moving to review.
```

The next, and every one after, gave the revisit:

```text demos/deep-research/recorded/1/calls/005.txt
Dispatch while another sub-task is offered; otherwise wait until all of your subagents are complete, then move to review.

Offered — each shown in full on an earlier response in this state; call describe <event> to see one whole:

- task.next → researching
```

**A move shown whole is then named alone.** That's the second half of `005`. A move printed whole while the actor was
in a state is printed by name on later responses in that state, for as long as its text doesn't change
([ADR-0016](./adr/0016-a-move-shown-whole-is-then-named.md)). The text is the destination's description, the move's
description, its `Requires:` line and its schema. A destination whose every move is named loses its heading.
"In that state" lasts the actor's life, so a state entered again later also names its moves.

A move whose text did change is printed whole again. A worker's `search.results` schema is the query it's on, so every
new query prints it whole, while `queries.add`, unchanged, stays named:

```text demos/deep-research/recorded/1/calls/027.txt
## To move to state: searching (Queries are being worked one at a time.)

### search.results → searching (Another query is waiting.)

    query: "Lake Taneycomo public fishing access Branson MO Fall Creek Rockaway Beach"

Also offered — each shown in full on an earlier response in this state; call describe <event> to see one whole:

- queries.add → searching
```

**A schema already shown is left out.** A move printed whole, because it's new to this state, still drops its schema
when this actor was already shown that exact schema for that move somewhere else. A line takes its place, so it doesn't
read as a move with no payload:

```ts packages/backseat-ai/src/runtime/render.ts
else if (event.schemaShown) lines.push(`call describe ${event.type} to see its schema`)
```

Run 1 has no such line.

**Said once and never again:**

- The drive protocol, on the actor's first response.
- `## Subagents to start`, on the call that spawned them. A parent that wants to know more asks the child.
- Whatever `data` shows from the event, on the response to that `send`.
- The opening line, on `create`.

## `describe`

**With an event**, `describe` prints that one move and nothing else: its destination, its description and its schema,
always whole ([ADR-0015](./adr/0015-describe-takes-just-the-event.md)). A worker's subagent called it before sending:

```text demos/deep-research/recorded/1/calls/061.txt
## To move to state: complete (The sub-task is finished, with a finding or a stated absence.)

### finding.submit → complete (The sub-question is answered.)

    summary: string   // min length 80
    sources: {
      url: string     // uri
      title: string   // min length 1
    }[]               // min 1 items

---
1b36b700-73f1-4497-80fd-993bb42a624f/task-1-2 · at summarizing · active
```

It describes only a move that's offered now. A move that isn't offered, or one held back for pending children, is
refused exactly as sending it would be (see [rejections](#rejections)), and so is any event on an actor that has
finished.

**Without an event**, it prints the state as a first arrival would: the first-arrival instructions whatever the actor
has seen, the `data`, and every move whole. It's for a driver that inherits an actor mid-flight, where `snapshot` would
hand it the revisit text. It's never refused.

## Rejections

A `send` the runtime refuses leaves the actor where it was and exits 2. The response leads with the news, then repeats
the arrival the actor is still at, so the driver can act without another call:

```text demos/deep-research/recorded/1/calls/011.txt
$ node cli.ts --drive send 1b36b700-73f1-4497-80fd-993bb42a624f task.next
# started 2026-11-07T19:23:43Z, exit 2

Rejected: that event is not offered from the current state, researching, right now. Send only an event listed below.

The actor has not moved.

Dispatch while another sub-task is offered; otherwise wait until all of your subagents are complete, then move to review.

No move is offered until your subagents finish their workflows.

---
1b36b700-73f1-4497-80fd-993bb42a624f · at researching · active
```

That's the driver sending `task.next` past the last sub-task, whose guard no longer passed. Every rejection opens on
`Rejected:` and says `The actor has not moved.` before the arrival. The arrival under it leaves out the transition's
instructions, since no transition was taken. Nothing else changes.

The reason is one of nine:

```ts packages/backseat-ai/src/runtime/runtime.ts
export type RejectReason = 'unknown-event' | 'not-enabled' | 'invalid-payload' | 'transition-not-taken' | 'pending-children' | 'refused' | 'action-failed' | 'actor-done' | 'actor-error'
```

The driver never sees the code. It reads the first line, which each reason words like this:

```ts packages/backseat-ai/src/runtime/render.ts
function headline(rejection: Rejection): string {
  switch (rejection.reason) {
    case 'invalid-payload':
      return 'the payload does not match the schema.'
    case 'unknown-event':
      return `that event is not offered from ${where(rejection)}.`
    case 'not-enabled':
      // Defined here, hidden by its guard. A move not offered now is never listed (ADR-0008), so the news is that it is
      // not offered from the state the actor is in, named — not that it is "conditional", which read as a promise.
      return `that event is not offered from the current state, ${where(rejection)}, right now. Send only an event listed below.`
    case 'transition-not-taken':
      return 'no transition took that event from here.'
    case 'pending-children':
    case 'refused':
      return rejection.message ?? 'the implementation refused this event.'
    case 'action-failed':
      // Not a refusal: an action threw. The actor did not move and nothing it did was kept, so the news is the
      // failure itself and that trying again is allowed.
      return `an action failed and nothing it did was kept: ${rejection.message ?? 'no message'}`
    case 'actor-done':
      return 'this actor is done. Nothing more can be sent.'
    case 'actor-error':
      return 'this actor has errored. Nothing more can be sent.'
  }
}
```

The code is in the run's trace ([`runs.md`](./runs.md)), which is where `unknown-event` and `not-enabled` can be told
apart. `RejectReason` isn't exported from `backseat-ai`. A `send` is checked in this order, and the first check that
fails is the reason:

| Reason | When | Also from `describe <event>` |
| --- | --- | --- |
| `actor-done`, `actor-error` | The actor has reached a final state, or has errored. | yes |
| `unknown-event` | No active state defines the event at all. | yes |
| `not-enabled` | A state defines it, but its guard fails right now. | yes |
| `pending-children` | It collects a site where a child is still pending. The payload isn't looked at. | yes |
| `invalid-payload` | The payload doesn't match the contract. | no |
| `transition-not-taken` | No transition takes the event once its payload is added, as when a guard reads the payload. | no |
| `refused` | An effect or an action threw [`RejectedEvent`](./machines.md#rejectedevent). | no |
| `action-failed` | An effect threw anything else, an action on a [collecting](./subagents.md#collectchildren) transition did, or a spawn reused the [id](./subagents.md#child-ids) of a child still held. | no |

Run 1 has only `not-enabled` (`011`, `012`). Its driver waited for its workers by polling `snapshot`, which is never
refused, and none of its payloads failed a schema.

**`pending-children`** names every pending child by the id its subagent drives it by, and says to send again:

```ts packages/backseat-ai/src/runtime/runtime.ts
const stillRunning = (pending: Pending[]) => `these subagents have not finished their workflows: ${pending.flatMap((p) => p.children).join(', ')}.`
```

```ts packages/backseat-ai/src/runtime/runtime.ts
if (pending.length) return reject('pending-children', { pending, message: `${stillRunning(pending)} Send ${type} again once they have.` })
```

From `describe`, the second sentence is `<event> is offered once they have.` instead.

**`invalid-payload`** lists each issue by its path, then prints the whole contract:

```ts packages/backseat-ai/src/runtime/render.ts
if (rejection.issues?.length) blocks.push(rejection.issues.map((issue) => `- \`${issue.path}\`: ${issue.message}`).join('\n'))
if (rejection.schema) blocks.push('The schema for this event:\n\n' + schemaBlock(rejection.schema))
```

**`refused`** and **`action-failed`** carry the thrown message, so a `RejectedEvent` should say what to do instead.
After `action-failed` the same event can be sent again. One refused for a reused id is refused again until that
child is collected.

## When the actor finishes

A final state's instructions still lead, because they were written for this moment. The status line follows them, and
no moves are listed:

```text demos/deep-research/recorded/1/calls/072.txt
You are done. The report you drafted and cited is delivered to whoever handed you this tool; they read it from this actor, not from you, and nothing further is offered here. Tell them this actor is complete, give them its id, and stop.

This actor is done. Nothing more can be sent.

---
1b36b700-73f1-4497-80fd-993bb42a624f · at complete · done
```

An actor errors when an action on a transition that collects nothing throws anything but `RejectedEvent`. That's how a
worker breaks, and its parent collects it with `status: 'error'`. The response to that `send` leads with
`This actor has errored: <message>. Nothing more can be sent.` It isn't a rejection, so the call exits 0. Every later
`send` to that actor is refused as `actor-error`. Run 1 had no errored actor.

## Exit codes

```ts packages/backseat-ai/src/runtime/cli.ts
if ((response as ToolResponse & { rejected?: true }).rejected) process.exitCode = 2
```

| Code | Means | Printed on |
| --- | --- | --- |
| 0 | The call answered: an arrival, a description, the usage response. That includes reaching a final state and erroring. | stdout |
| 2 | The runtime refused the event, from `send` or `describe <event>`. The actor didn't move. | stdout |
| 1 | The call itself failed: an unknown actor or machine, a payload that isn't JSON, a missing argument or an unknown command. | stderr |

An exit 1 prints one line and no arrival, since there may be no actor to show. A missing argument or an unknown command
adds the usage response under it. A subagent in run 1 ran the placeholder in its own prompt literally, then took its
real id:

```text demos/deep-research/recorded/1/calls/019.txt
$ node cli.ts --drive snapshot 1b36b700-73f1-4497-80fd-993bb42a624f/task-1-N
# started 2026-11-07T19:24:35Z, exit 1


# stderr:
Unknown actor '1b36b700-73f1-4497-80fd-993bb42a624f/task-1-N'
```

A child that's already been collected and stopped is no longer an actor to drive, so a call naming it also exits 1, and
the message says how it ended and that its output is kept in the run's record. A payload that isn't valid JSON fails
before the actor is looked at, so it exits 1, not 2: the schema never saw it.
