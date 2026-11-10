---
name: backseat-ai
description: Companion for a project that depends on `backseat-ai`, routing to its installed docs and adding the patterns and craft they leave out. Use when writing, changing, reviewing or debugging a Backseat machine (`backseat().createMachine`, `instructions`, `data`, `schema`, spawned subagents, `collectChildren`), reading or repairing a run, answering a `lint` finding, or exporting to Stately Studio. Not for plain XState with no Backseat in it.
---

# backseat-ai

A Backseat machine is a workflow an agent drives. The agent holds one tool and sees only the moves enabled from where
it is, so the machine's whole job is **position and refusal**: telling the agent where it stands in the work, and
declining every move that isn't open from there. Read every task below through that.

## The docs

The docs are the surface: every key, type, command and response. They install with the package, at
`node_modules/backseat-ai/docs/`, and `README.md` there orders them. This skill names a section as
`machines.md` § `schema`: that file, under that heading.

- No `node_modules/backseat-ai/docs/`: the project doesn't have the package yet. Run `npx backseat-ai init` in it.
- Yarn PnP, with no `node_modules`: read `https://github.com/pottedmeat/backseat-ai/tree/v<version>/docs`, with the
  `backseat-ai` version the project's lockfile holds.

The installed docs match the installed code, and this skill tracks the latest release, so where the two disagree the
docs are right.

## Route the task

| Task | Read |
| --- | --- |
| Start a project, or add Backseat to one | `quickstart.md` |
| A plain XState concept, or what Backseat refuses or narrows | `xstate.md`, which links the Stately page for each |
| Write or change a machine | `machines.md`, then the pattern below that fits |
| A string the agent reads | `machines.md` § `instructions`, § `data`, § `schema`, then [craft](references/craft.md) |
| Stop a move the agent shouldn't make | [Hide or refuse](references/patterns.md#hide-or-refuse), then `machines.md` § `effect` and § `RejectedEvent` |
| A transition written outside the machine | `machines.md` § `transition` |
| Hand work to subagents | `subagents.md`, then [Fan-out round](references/patterns.md#fan-out-round) |
| A machine that fails to build at import | `machines.md` § `backseat()` and `createMachine`, and `xstate.md` § Refused |
| How a response, a refusal or an exit code reads | `driving.md` |
| Where a run lives, or reading and repairing one | `runs.md` § Reading a run, and `cli.md` § `backseat-ai` for the commands |
| A `lint` finding or decline | `style.md`, under the rule the finding names |
| A command or environment variable | `cli.md` |
| A diagram for a person | `stately.md` |
| Review a machine | [Review a machine](#review-a-machine) |
| See what an agent sees | [See what an agent sees](#see-what-an-agent-sees) |

## Patterns

[`references/patterns.md`](references/patterns.md) holds the shapes the docs show only in pieces. Each says what it
combines, why it's shaped that way, quotes a demo, and links the doc for each piece. Reach for one by name:

- [Fan-out round](references/patterns.md#fan-out-round)
- [Splitting what was collected](references/patterns.md#splitting-what-was-collected)
- [One contested event or two](references/patterns.md#one-contested-event-or-two)
- [Hide or refuse](references/patterns.md#hide-or-refuse)
- [Bounding a loop](references/patterns.md#bounding-a-loop)
- [A derived schema across rounds](references/patterns.md#a-derived-schema-across-rounds)
- [A shared contract on the state](references/patterns.md#a-shared-contract-on-the-state)
- [Checking what an `assign` wrote](references/patterns.md#checking-what-an-assign-wrote)
- [Every way to end](references/patterns.md#every-way-to-end)
- [Machine-to-machine output](references/patterns.md#machine-to-machine-output)
- [Courier](references/patterns.md#courier)
- [An effect that decides](references/patterns.md#an-effect-that-decides)
- [Checkpoint](references/patterns.md#checkpoint)

## Review a machine

1. Run `node cli.ts lint <machine>` from the project. Each finding names its rule in `style.md`; fix it, or weigh the
   rule's reason and say why it doesn't apply. Each check that **declines** names what it couldn't see: answer that
   check by hand (`style.md` § When every check declines).
2. Answer the seven reviewer's questions, which `lint` can't check. Each links its rule in
   [`references/craft.md`](references/craft.md):

   - [`why-in-prose`](references/craft.md#why-in-prose): does every instruction say why the step is wanted, and leave
     each field's meaning to the field?
   - [`keep-what-outlives-the-call`](references/craft.md#keep-what-outlives-the-call): does every `assign` from an
     effect's output keep only the part something after this call reads?
   - [`describe-the-place`](references/craft.md#describe-the-place): does each state's description say what the state
     is once reached, and each transition's say why the agent would take it now?
   - [`say-what-to-do`](references/craft.md#say-what-to-do): does every instruction say what to do, and leave which
     event carries it to the offered list?
   - [`every-way-to-end`](references/craft.md#every-way-to-end): when the agent tried and could not, or found nothing
     to do, does it have an ending that says so?
   - [`hide-or-refuse`](references/craft.md#hide-or-refuse): does a guard hide each move the context already rules out,
     and does a refusal decline each move only the event can rule out, saying what to do instead?
   - [`say-how-children-are-driven`](references/craft.md#say-how-children-are-driven): do the first-visit
     instructions of every state that spawns say to start a subagent for each child listed, give it its command, wait
     for all of them, and why?

The review is done when every finding is fixed or answered, every decline is answered by hand, and every question is
answered yes or has a change behind it.

## See what an agent sees

Start one actor in a throwaway run directory, with
`BACKSEAT_STATE_DIR="$(mktemp -d)" node cli.ts --drive create <machine>` from the project, and read the response as
the agent will. Read it for position and refusal: does it say where the agent stands and what to do now, and are the
moves offered only the ones open from here? `driving.md` § An arrival says what each part of the response is.
