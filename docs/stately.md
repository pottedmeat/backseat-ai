# Viewing a machine in Stately Studio

`node cli.ts stately` writes a machine as a file [Stately Studio](https://stately.ai) can draw. The file is for looking
at. Nothing reads it back, and the machine value stays the only thing you edit
([ADR-0010](./adr/0010-the-stately-export-is-a-view.md)).

## Writing the files

From inside the project, run `node cli.ts stately [<machine>...] [--out <dir>]`. It reads the catalog the project's
`cli.ts` names, and writes one machine per file:

```ts packages/backseat-ai/src/cli/stately.ts
/**
 * A catalog machine and every machine its roster spawns, one file each, so each pastes into Studio on its own. The
 * catalog machine's file is `<name>.stately.ts`; a spawned machine's is its parent's name and its roster key,
 * `<name>.<src>.stately.ts`, and the parent names that file in its `setup({ actors })`.
 */
```

So the deep-research demo writes `deep-research.stately.ts` and `deep-research.researchTask.stately.ts`. A machine
that a spawned machine spawns in turn adds its own key to the name. A machine the roster holds twice is written once.

The files go into `--out`, or into the current directory without it, and the command prints each file's path. Naming
machines writes only those and what they spawn. A name that isn't in the catalog is an error, and nothing is written.

To view one, open the file, copy it, and choose **Import from code** in Studio.

### TypeScript 5

The command reads each state's `data` type with the TypeScript compiler API, so the project needs TypeScript 5
installed. It looks from the catalog's directory for `typescript5` first, which is TypeScript 5 under an alias, then
for `typescript` if that one has the API. Nothing else in Backseat needs it. When it finds neither, it says what to
install:

```ts packages/backseat-ai/src/cli/stately.ts
'Install TypeScript 5 there: `npm install -D typescript@5`, or beside TypeScript 7, which has no API, ' +
  '`npm install -D typescript5@npm:typescript@^5.9`.',
```

## What you see, and where

Studio shows only what XState knows about, so Backseat's own keys go where Studio displays them. The context it shows
is the machine's initial context, from its `sampleInput` if it has one.

| In the machine | In Studio |
| --- | --- |
| `description` | The state's or transition's description, as written. |
| `instructions` | Added to the description under **Instructions**, on a state or a transition. A function is called against the initial context for both visits, and shows **First visit** and **Revisit** when they differ. |
| A transition's `schema` | Added to the transition's description under **Payload**: each field, its type, whether it's optional, its `.describe()` text, and a few of its constraints (a format, a minimum, a minimum length or count). A schema built from context is shown against the initial context, and says so. The full JSON Schema is in the transition's `meta`, and the machine's event schemas carry the field types. |
| A state's `schema` | Added to the description under **Payload on entry**. |
| `data` | Added to the description under **Data**, as the type the agent receives. Named types are written out in full. The function that computes it isn't shown. |
| Guards | Named guards. A guard that's a named function keeps its name, so a guard hoisted to a `const` keeps the `const`'s. An inline one is named `guard@` plus the transition it's on. |
| Actions | Named actions. An `assign` given an object is called `set` plus the context keys it writes, like `setReviewedConcerns`. An `assign` given a function is called `assign`. Any other action keeps its function's name, or is `inline@` plus where it's used. Actions with the same source share one name. Where two different ones would get the same name, each gets `@` plus where it's used. |
| `collectChildren` | Added to the collecting transition's description under **Collects**. |
| The `actors` roster | Each machine it holds is written to its own file. The parent's `setup({ actors })` names that file, like `"researchTask": "./deep-research.researchTask.stately.ts"`, so Studio's actor list tells you which file to paste to see it. That isn't actor logic XState would accept, so an editor will flag it. Nothing runs the file. |

The root's own `instructions`, `data` and `schema` go into its `meta` only, since Studio has no description for the
machine as a whole. Implementations show in Studio's Sources panel as the source text of the running function. Studio
doesn't run them.

## Spawns

Studio doesn't draw spawned actors. So a `spawnChild` on a state's entry, or on one of its transitions, is drawn as a
purple transition, `spawn:<src>`, from the state that spawns to where the collecting transition goes. Its description
says that an agent is spawned that runs that machine, and when. A spawn nothing collects says so and goes nowhere. The
state that spawns is tagged `spawns:<src>`.

`spawn:<src>` isn't an event anyone can send. Studio still lists it among the machine's events.

## Tags

Tags mark what a person would otherwise miss. When a description already says something, there is no tag for it.

| Tag | Means |
| --- | --- |
| `spawns:<src>` | This state spawns agents that run `<src>`. |
| `refines:<event>` | `<event>`'s payload has a check on the object as a whole, beyond its fields' types, so a payload whose every field matches can still be refused. A check on one field isn't tagged. |
| `effect:<event>` | The transition on `<event>` calls a tool through its [`effect`](./machines.md#effect) before it's taken. What the tool returns reaches the actions and `data` as `event.output`. |
| `may-refuse:<event>` | An action or the `effect` on `<event>` names `RejectedEvent` in its source, so a send with a valid payload may still be refused. On an entry or exit action the tag is `may-refuse:entry` or `may-refuse:exit`. It's found by reading their source, so a throw inside a helper they call is missed. |

## What is left out

- **The machinery the compiler adds.** That's the tracking slice of context, the `agent.presented` event, the handler
  for a child that fails, the note behind a spawn's `about`, and `stopCollected`. You didn't write them, and no agent
  sends them.
- **Types for context.** Studio's context panel guesses types from the initial values (`pr: null`). It ignores both
  forms of context type that code can give it.
- **Anything you change in Studio.** Nothing comes back from Studio into the machine.
- **What an effect does.** An [`effect`](./machines.md#effect) isn't drawn, since Studio has no shape for work done
  inside a transition. It's tagged `effect:<event>`, but which tool it calls and what it returns aren't shown.
