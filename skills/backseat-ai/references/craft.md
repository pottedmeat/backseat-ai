# Craft lint can't check

Seven rules for a machine an agent reads well, none of which `lint` can hold, because each needs judgement about prose
or intent. `SKILL.md`'s review entry links each rule here by its heading. The four rules `lint` does check are in
`style.md`, and its findings explain themselves.

Each gives the reviewer's question, the reason, a smell to search for, and a before and after. The before is
invented; the after is quoted from a demo.

## `why-in-prose`

**Prose says why the step is wanted; the schema says what each field is.**

Reviewer's question: does every instruction say why the step is wanted, and leave each field's meaning to the field?

**Reason.** The schema is rendered in full beneath the instructions. Prose that lists the fields says everything twice,
and the prose copy is the one that goes stale when a key is renamed. A field's meaning belongs on the field, with
zod's `.describe()`, which reaches the agent in the rendered type (`machines.md` § `schema`). Give a field a
`.describe()` when its name alone leaves the agent guessing.

**Smell.** A field name that appears both in `instructions` and in the schema of a transition the state offers.

**Before.** "Open the pull request and send back its url, title, the branch it merges into, the branch it comes
from, and how many files it changes."

**After.** The instructions give the reason; the fields carry their own meaning.

```ts demos/pr-review/pr-review.ts
instructions:
  'You are reviewing a pull request. Before anything else, open the one you were given and send back its ' +
  'identity. A pull request you cannot open is not one you can review, and the file count is how ' +
  'this workflow knows you opened it rather than echoed back the url.',
```

```ts demos/pr-review/pr-review.ts
schema: z.object({
  url: z.url().describe('the pull request you opened'),
  title: z.string().min(1).describe('its title, as the pull request gives it'),
  baseRef: z.string().min(1).describe('the branch it merges into'),
  headRef: z.string().min(1).describe('the branch it comes from'),
  changedFiles: z.number().int().min(1).describe('how many files its diff touches'),
}),
```

## `keep-what-outlives-the-call`

**A value the call returned touches context only if it must outlive the call.**

Reviewer's question: does every `assign` from an effect's output keep only the part something after this call reads?

**Reason.** An effect's output reaches both the transition's actions and the landing state's `data` (`machines.md` §
`effect`). `data` shows it on this one response, and the agent holds it from then on. An `assign` makes it a fact the
machine carries on every later call and in the run record. Keep the part a later guard, schema, `data` or another
driver reads, and let `data` show the rest once.

**Smell.** An `assign` that copies `event.output` whole.

**Before.** `actions: assign({ notes: ({ context, event }) => [...context.notes, event.output] })`, which stores every
note's text so the machine can count reads.

**After.** The machine keeps the id it counts, and `data` shows the note on the response that read it.

```ts demos/one-value/effects.ts
data: ({ context, event }) => ({
  reads: context.reads.length,
  ...(event?.type === 'note.read' && { note: event.output }),
}),
```

```ts demos/one-value/effects.ts
// The machine keeps which notes were read, never what they said: the agent was shown that once.
actions: assign({ reads: ({ context, event }) => [...context.reads, event.output.id] }),
```

An output a different driver must read, such as a child's for its parent, has to outlive the call. Keep it.

## `describe-the-place`

**A description says what is there, and why you would go.**

Reviewer's question: does each state's description say what the state is once reached, and each transition's say why
the agent would take it now?

**Reason.** Descriptions are read while the agent chooses its move, and the offered list shows a target's description
beside each transition into it (`driving.md` § An arrival). Read together they say where the agent could go and why.
So a state's description is a present-tense condition of the state once reached. A transition's is a claim the agent
can check against what it knows, and it may well be an absence. A final state is the one place a finished act is the
condition: nothing follows it, so its description says what the run came to.

The event's name is read beside that description, and it's what the agent sends. So name it `subject.verb`, for the
agent's act at the moment it sends (`plan.submit`, `item.next`) or for its verdict (`review.clear`, `pr.unreachable`).
Not for something already done (`bug.filed`): the agent does it by sending.

**Smell.** On a state that isn't final: the event's verb in the past tense ("is reported", "has been submitted"), an
imperative, or "has not", "yet", "so far", which describe the state before this one.

**Before.** A state described by the move that reached it, `description: 'The result is reported to the lead.'`, and
one described by what is missing, `description: 'The pull request has not been investigated yet.'`.

**After.** A state described as it is, and a transition described by why an agent would take it.

```ts demos/deep-research/research-task.ts
summarizing: {
  description: 'Every query has been answered; the sub-task needs a written finding.',
```

```ts demos/deep-research/research-task.ts
'finding.empty': {
  target: 'complete',
  description: 'Nothing found supports an answer.',
```

A final state, described by what the run came to.

```ts demos/deep-research/deep-research.ts
complete: {
  type: 'final',
  description: 'The report is written and cited.',
```

## `say-what-to-do`

**Instructions say what to do here, not which event to send.**

Reviewer's question: does every instruction say what to do, and leave which event carries it to the offered list?

**Reason.** Every response ends with the enabled transitions, each with its event, schema and description. An
instruction that names one repeats what the response already says below it, and it is the copy that goes stale when
the event is renamed. It also makes the choice the list exists to leave open. Say what to do in this state, in the
domain's words, and let the list say how it is sent and where it leads. A final state is the exception: it offers
nothing (`machines.md` § `instructions`).

**Smell.** A backticked event type, "send", "then", or a state's name inside an instructions string.

**Before.** "Write the finding and send `finding.submit`, or say so with `finding.empty`, or send `search.resume`
with more queries."

**After.** Three choices, each in the domain's words.

```ts demos/deep-research/research-task.ts
: 'Conclude on `data.subQuestion`: write the finding, say that nothing supports an answer, or resume ' +
'the search.',
```

## `every-way-to-end`

**Give the machine every way to end, not just success.**

Reviewer's question: when the agent tried and could not, or found nothing to do, does it have an ending that says so?

**Reason.** A state whose exit depends on something outside the agent's control needs a way to end when it can't be
met, or the agent is asked forever for a thing it hasn't got. Work that turns out to be unnecessary ends the run
instead of passing through steps that inspect nothing. These are final states, not rejections: a rejection leaves the
actor where it was, which suits a malformed payload and not work that can't happen. Put each door in the state where
the finding is made. Where an ending's door sits decides what its guard has to do, so re-read a transition's guard and
refusals whenever you change its target.

**Smell.** A machine with one final state, or a state whose only way out needs something the agent may not be able to
get.

**Before.** `validating` offers only `pr.verified`, so an agent that can't open the pull request has nothing honest to
send.

**After.** A way out for the agent that tried and couldn't, carrying the reason into the record.

```ts demos/pr-review/pr-review.ts
'pr.unreachable': {
  target: 'unreachable',
  description: 'The pull request cannot be opened, and there is nothing to review.',
  schema: z.object({
    why: z.string().min(1).describe('what happened when you tried to open it — the error, the status, or what was missing'),
  }),
  actions: assign({ why: ({ event }) => event.why }),
},
```

## `hide-or-refuse`

**Hide what the context already rules out; refuse what only the transition can decide.**

Reviewer's question: does a guard hide each move the context already rules out, and does a refusal decline each move
only the event can rule out, saying what to do instead?

**Reason.** A guard hides a move: the agent never sees it and is told nothing. A refusal, a `RejectedEvent` thrown from
the effect, leaves the move listed and declines it with a message (`machines.md` § `RejectedEvent`). A guard reads
context, so it suits a move the context already proves invalid. A refusal has the event in hand, so it suits what only
the event reveals: an externality, values that conflict, a check a schema can't express. The message is the whole
value of a refusal, so write it as what to do instead, in moves this state offers. A transition explains itself
through its description when it appears, so other states' instructions leave hidden moves unmentioned. If hiding a
move leaves an agent with nowhere to put a sincere belief, the machine needs another ending (see `every-way-to-end`).

A schema derived from context is a third way, for a value rather than a move: the move stays offered, and its contract
accepts only what the context allows (`machines.md` § `schema`). The agent sees the narrowed contract before it sends.
A payload outside it is refused as `invalid-payload` with zod's message, which says only what was expected, so
`.describe()` the narrowed field with why.

**Smell.** A refusal that tests only context, a refusal message that only says no, or instructions that announce a
move another state hides.

**Before.** `review.clear` stays offered over a red check the agent already reported, and its effect throws
`RejectedEvent('Checks failed.')`.

**After.** The context rules the move out, so a guard hides it.

```ts demos/pr-review/pr-review.ts
// A context guard, not a schema: the agent already told the machine a check failed, so the move is simply
// not offered rather than asked for and refused.
guard: checksPassed,
```

Only the event can show a cited page is gone, so the effect refuses, and says what to do instead.

```ts demos/deep-research/research-task.ts
return status === 404 || status === 410
  ? `${url} is gone (HTTP ${status}). Cite the page you read instead, or drop it and say what rested on it.`
  : null
```

## `say-how-children-are-driven`

**A state that spawns says how its children get driven, and why.**

Reviewer's question: do the first-visit instructions of every state that spawns say to start a subagent for each
child listed, give it its command, wait for all of them, and why?

**Reason.** The runtime lists each child and its first command, and says nothing more (`subagents.md` § Driving the
children). Without the instructions saying it, the children are never driven and the run hangs. Give the reason too:
a subagent keeps its child's work out of the driver's context and lets the children run side by side. A bare order is
one a driver weighs against its overhead, and may skip by driving every child itself. Name no command: the response
lists it, and each child's driver learns the tool on its own first response.

**Smell.** A state with a spawn whose instructions don't mention subagents, give no reason, or spell out a command.

**Before.** "Start the workers by running the snapshot command for each one."

**After.** Start one each, give it the listed command, say why, and wait.

```ts demos/deep-research/deep-research.ts
'picked are not run, and you may propose them again in a later round. For each one, spawn a subagent ' +
'and tell it to run the listed command: each worker\'s searches and pages then stay out of your context, ' +
'and the workers run side by side. Keep dispatching while another sub-task is offered, then wait until ' +
'all of your subagents are complete before moving to review.'
```
