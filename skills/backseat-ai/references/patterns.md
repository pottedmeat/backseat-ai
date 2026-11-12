# Patterns

Thirteen shapes the docs show only in pieces. Find the pattern by name, read its **Why** before you copy its shape,
and follow the **Docs** links for each piece it combines. The docs own every key, type and response; a pattern only
says how the pieces fit and what pushes them into that shape. Each excerpt is quoted from a demo in
`github.com/pottedmeat/backseat-ai`.

1. [Fan-out round](#fan-out-round)
2. [Splitting what was collected](#splitting-what-was-collected)
3. [One contested event or two](#one-contested-event-or-two)
4. [Hide or refuse](#hide-or-refuse)
5. [Bounding a loop](#bounding-a-loop)
6. [A derived schema across rounds](#a-derived-schema-across-rounds)
7. [A shared contract on the state](#a-shared-contract-on-the-state)
8. [Checking what an `assign` wrote](#checking-what-an-assign-wrote)
9. [Every way to end](#every-way-to-end)
10. [Machine-to-machine output](#machine-to-machine-output)
11. [Courier](#courier)
12. [An effect that decides](#an-effect-that-decides)
13. [Checkpoint](#checkpoint)

## Fan-out round

**Combines:** a spawn on entry, a guarded self-transition that re-enters, a queue in context, `about` on each spawn,
a collecting transition, and a handoff in the first-visit instructions.

**Why.** Nothing reaches a parent until its driver asks, so a round of workers is a barrier the lead crosses by
sending a move. Collecting makes that move unavailable while any worker is still out, so the lead can't cross early.
One child per entry gives each spawn its own `about`, resolved at the spawn, and its own id. The id carries the round
and the dispatch count, so the driver, a pending refusal and the record can each tell one worker from another. The
queue stays in context: the lead sees the next move, never the list. The spawning state's first-visit prose says how the
children get driven: [`say-how-children-are-driven`](craft.md#say-how-children-are-driven).

```ts demos/deep-research/deep-research.ts
entry: spawnChild('researchTask', {
  id: ({ context }) => `task-${context.round}-${context.dispatched}`,
  about: ({ context }) => context.current?.subQuestion ?? '(no sub-question)',
  input: ({ context }) => ({
    subQuestion: context.current?.subQuestion ?? '',
    question: context.question,
  }),
}),
```

```ts demos/deep-research/deep-research.ts
'task.next': {
  guard: hasPending,
  target: 'researching',
  reenter: true,
  description: 'Another sub-task is waiting to be dispatched.',
  actions: assign(takeTask),
},
```

**Docs:** `subagents.md` § `spawnChild`, § Child ids, § `about`, § Driving the children, § `collectChildren`;
`xstate.md` § Every machine uses these (self-transitions and `reenter`).

## Splitting what was collected

**Combines:** a collected `assign`, each child's status, output and `about`, a narrowing helper, and `data` that shows
each kind under its own key.

**Why.** A child can end three ways, and each asks something different of the lead. A finding is read. A stated
absence was searched and failed, so asking it again unchanged buys nothing. A child that broke was never really
tried, so it can go out again as it was. Merged into one list, the lead would re-issue the dead ends and drop the
breakages. Split them where they're collected: once a child is collected it's stopped, and the collection is the last
place its output appears. A child's output arrives untyped, so narrow it before trusting it. A broken child has no
output at all, and its `about` is the only thing left that says what it was for.

```ts demos/deep-research/deep-research.ts
/** A sub-question a worker searched and could not answer. Re-issuing it verbatim buys nothing. */
type Unanswerable = { actorId: string; subQuestion: string; reason: string }
/** A worker that broke. Its sub-question was never really tried, so it can be re-commissioned unchanged. */
type Failed = { actorId: string; subQuestion: string; error: string }
```

```ts demos/deep-research/deep-research.ts
const report = child.status === 'done' ? asReport(child.output) : null
if (!report)
  failed.push({
    actorId: child.actorId,
    subQuestion: String(child.about ?? '(unrecorded)'),
    error: String(child.error ?? `worker ${child.status}`),
  })
```

**Docs:** `subagents.md` § `collectChildren`, § `about`; `machines.md` § `data`.

## One contested event or two

**Combines:** a contest (several transitions under one event, guards tried in order), or two events on complementary
guards; guards hoisted to named consts.

**Why.** Ask whether the agent's act is the same either way. When it is, use one event and let the machine pick the
consequence. A worker reports the query it ran the same way whether more are waiting or that was the last; only the
machine knows which, so the guard decides. When the acts differ, use two events. Dispatching another worker and
moving on to review are different things to do, so each gets its own event and description, and the offered list
reads as one move at a time. Either way, hoist each guard: the record names a contested branch by its guard's name,
and an inline arrow has none worth reading.

```ts demos/deep-research/research-task.ts
'search.results': [
  {
    guard: queueDrained,
    target: 'summarizing',
    description: 'That was the last query.',
    schema: ({ current }) => z.object({ query: z.literal(current ?? '') }),
    actions: assign({ current: () => null }),
  },
  {
    description: 'Another query is waiting.',
    schema: ({ current }) => z.object({ query: z.literal(current ?? '') }),
    actions: assign(takeNext),
  },
],
```

```ts demos/deep-research/deep-research.ts
// Two events, not one contested `task.next`: the dispatch is offered while the queue holds a sub-task, the
// review once it is drained, so the offered list reads as one move at a time.
'research.review': {
  guard: queueDrained,
```

**Docs:** `xstate.md` § Every machine uses these (guards, and the first one that passes wins); `driving.md` § The
moves; `runs.md` § The trace; `stately.md` § What you see, and where.

## Hide or refuse

**Combines:** a guard on context, an `effect` that throws `RejectedEvent`, and a way on for the agent the guard
leaves behind.

**Why.** Choose by when the invalidity is knowable: a guard for what context already proves, a refusal for what only
the event in hand can show. The rule, its reasons and its examples are [`hide-or-refuse`](craft.md#hide-or-refuse).
The shape adds two things. Refuse in the effect, which runs before any action, so nothing has been written when the
refusal lands. And give the agent a guard hides a move from an honest alternative on offer, or it is stuck holding a
belief with nowhere to send it. In pr-review, with a red check reported, that's another round or the blocked ending.

**Docs:** `machines.md` § `effect`, § `RejectedEvent`; `driving.md` § Rejections; `xstate.md` § Every machine uses
these (guards).

## Bounding a loop

**Combines:** a round count in context, and either two transitions on complementary guards or one guarded way round
beside an exit that's always open.

**Why.** An agent that can't finish in five rounds won't finish in fifty, and shutting the way round with nothing else
open strands it. `lint` finds a loop with no way out, but it can't read guards, so the shape is yours. Pick the form by
what running out means. If reaching the bound is its own news, pair the guards: the way out opens exactly as the way
round shuts, and it leads to an ending that says the rounds ran out. pr-review does this, and its exit asks for what
is still wrong. If leaving early is always legitimate, guard only the way round and leave the exit open. deep-research
can conclude after any round, so at the bound only the conclusion remains. Bound the loop, not every move: a move that
closes genuinely finished work stays open at the bound. A loop that only corrects a submission needs no bound when each
rejection names exactly what to fix and a submission that holds is always within the agent's reach. deep-research's
citation check is one: a bound there would only add a way to end uncited.

```ts demos/pr-review/pr-review.ts
'review.concerns': {
  target: 'building',
  guard: withinBudget,
```

```ts demos/pr-review/pr-review.ts
'review.exhausted': {
  target: 'exhausted',
  guard: budgetSpent,
```

```ts demos/deep-research/deep-research.ts
'round.again': {
  guard: withinBudget,
  target: 'planning',
  description: 'Material gaps remain.',
```

**Docs:** `style.md` § `bound-every-loop`; `xstate.md` § Every machine uses these (guards).

## A derived schema across rounds

**Combines:** a schema written as a function of context, a field that accumulates across rounds, a refinement that
names what's missing, and a `.describe()` built from context.

**Why.** A derived contract narrows to the moment: each round must report every check the run has named so far. The
contract is exactly as wide as the field it reads. If a later round replaced that field, it could name fewer checks,
leave a red one off, and close green over it. So the field only grows. The refinement names which checks are missing,
because a refusal's message is what the agent acts on. At build time the field is empty, so the schema has to read
sensibly with nothing named yet.

```ts demos/pr-review/pr-review.ts
.superRefine((payload, ctx) => {
  const missing = namedChecks.filter((name) => !payload.checks.some((reported) => reported.check === name))
  if (missing.length)
    ctx.addIssue({
      code: 'custom',
      path: ['checks'],
      message: `not reported: ${missing.map((name) => `"${name}"`).join(', ')}. Report every check named in this run, passed or not.`,
    })
}),
```

```ts demos/pr-review/pr-review.ts
namedChecks: ({ context, event }) => [...new Set([...context.namedChecks, ...event.checks.map((check) => check.check)])],
```

**Docs:** `machines.md` § `schema`; `driving.md` § Rejections.

## A shared contract on the state

**Combines:** a schema on a state, the transitions that target it, and the contract the agent is shown (the state's
schema extended with the transition's).

**Why.** What it takes to enter a state belongs to the state. Put it there and every way in carries it, including a
way in added later, while each transition keeps only what is particular to it. deep-research requires a synthesis to
enter `drafting`, so a lead can't draft without one, however it arrived. The citation check is entered from two
states, and the one schema on `checking` holds both submissions to the same set.

```ts demos/deep-research/deep-research.ts
// What it takes to get here at all: the synthesis the lead must have written before it may draft. On the state
// rather than on `research.conclude`, so any later way in carries the same contract.
schema: z.object({ synthesis: z.string().min(80) }),
```

```ts demos/deep-research/deep-research.ts
* The contract for submitting citations. It lives on `checking`, the state both submissions target, because a schema
* on a state is the payload required to *enter* it and applies to every transition that targets it — so the two
* transitions that reach it, from `awaiting` and from `rejected`, share one contract rather than repeating it.
```

**Docs:** `machines.md` § `schema`; `driving.md` § The moves.

## Checking what an `assign` wrote

**Combines:** an `assign` that records the submission and its defects, a branch state left at once by an `always`
contest, an accepted final child, a rejected state whose `data` shows the defects, and a compound state left by
`onDone`.

**Why.** A refusal keeps nothing: the actor doesn't move and the message is all the agent gets. When the failure is
itself what the next attempt needs, write first and branch after. The `assign` computes which spans aren't in the
draft and which URLs no worker reported. The branch state reads that from context and goes to `accepted` or
`rejected`. `rejected` is a real state, with its own instructions, `data` listing each defect, and a way to resubmit.
The loop sits inside a compound state whose only way out is the accepted final child, so the report is complete only
through an accepted set.

```ts demos/deep-research/deep-research.ts
checking: {
  description: 'The submission is being checked against the draft and the reported sources.',
  schema: citationsSubmitted,
  always: [
    {
      guard: citationsHold,
      target: 'accepted',
      description: 'Every span is in the draft and every URL was reported.',
    },
    { target: 'rejected', description: 'The submission does not hold.' },
  ],
},
```

**Docs:** `xstate.md` § Machines that group states use these (parent states, `onDone`, `always`); `machines.md` §
`data`; `machines.md` § `RejectedEvent` (the alternative this replaces).

## Every way to end

**Combines:** several final states, a door to each with its own schema, an `outcome` each ending assigns on entry,
the root's `output`, and final instructions that differ by ending.

**Why.** A machine whose only ending is success asks the agent, when the work can't be done, for a thing it hasn't
got, and it will invent one. Give it the other endings: cannot proceed, nothing to do, rounds used up, blocked. The rule is
[`every-way-to-end`](craft.md#every-way-to-end); the shape is how the endings hang together. An ending's
door in a state that's only visited when the ending is possible needs no guard to hide it. Each ending names itself on
entry, so a door carries only what its event brought. Each ending's instructions are the last thing the agent reads:
name the act that closes the work out, and make an ending that isn't approval say so.

```ts demos/pr-review/pr-review.ts
// Without this the machine has no way to fail: an agent that cannot open the pull request is asked for an
// identity it has not got, forever. The only state that can be entered without the work having started.
'pr.unreachable': {
  target: 'unreachable',
```

```ts demos/pr-review/pr-review.ts
exhausted: {
  type: 'final',
  description: 'The rounds are used up with concerns outstanding.',
  entry: assign({ outcome: () => 'exhausted' as const }),
  // The ending most likely to be misread, so it says what silence would be read as.
  instructions:
    leaveReview('what you reviewed and every concern still open.') +
    ' Say plainly that the review ended at its round limit rather than because the work was done, so nobody ' +
    'reads silence as approval. Do not approve it.',
},
```

**Docs:** `style.md` § `spend-the-last-word`, § `store-nothing-unread`; `xstate.md` § Every machine uses these (final
states); `runs.md` § `output`.

## Machine-to-machine output

**Combines:** a child's root `output`, its final instructions, and the parent's collection.

**Why.** Output never reaches an agent. It rides to the parent with the child's finish, so the child's driver relays
nothing by hand: what it sent was validated, kept, and handed on by the machine. Say so in the child's final
instructions, or a careful driver will copy its finding into the parent's conversation too. Shape the output as the
contract between the two machines, with an exit per way the child can end. A parent that needs part of it in front of
its own driver shows that part through its own `data`.

```ts demos/deep-research/research-task.ts
output: ({ context }): TaskReport => ({
  subQuestion: context.subQuestion,
  summary: context.summary,
  sources: context.sources,
  unanswerable: context.unanswerable,
}),
```

```ts demos/one-value/one-value.ts
'Your note goes back to the lead with this actor\'s output: nothing to relay by hand, and nothing further ' +
'to send here. Stop driving this actor and return — your finishing is the only signal the lead gets that ' +
'this item is done.',
```

**Docs:** `xstate.md` § Machines that hand work to subagents use these (a machine's `output`); `subagents.md` §
`collectChildren`; `runs.md` § `output`.

## Courier

**Combines:** the scratch directory, a collected action that writes a file per child after the `assign`, and `data`
that names each file's path.

**Why.** A worker's summary is long, and only the lead's driver needs to read it, once. In context it would be
persisted and printed with every `data`. So the machine writes it to a file in the scratch directory and shows the lead
the path; context keeps only the sources a later check reads. The path is derived from the child's id wherever it's
shown, never stored. The writes come after the `assign`: a throw in a collected action discards the round, and a file
written before it would outlive the round it described. The scratch directory exists only inside a call, and building
the machine runs `data` outside one, so the path is computed inside the per-finding map that an empty context never
enters.

```ts demos/deep-research/deep-research.ts
const withFiles = (findings: Finding[]) => findings.map((f) => ({ ...f, file: findingFile(f.actorId) }))
```

```ts demos/deep-research/deep-research.ts
// The summaries go to files the lead's driver opens; only their sources enter context. They come after the
// `assign`: a throw there discards the round, and files already written would outlive it.
({ event }) => {
```

**Docs:** `runs.md` § `currentRun` and `scratchDir`; `subagents.md` § `collectChildren`; `machines.md` § `data`.

## An effect that decides

**Combines:** an `effect` on an event the agent sends, `output` declared on the event type, actions that keep what
the decision fixes, and `data` that shows its reason once.

**Why.** Some calls shouldn't be the driver's to make, because the driver is a party to them: how many rounds it gets,
which of its own proposals run. Put the judgment in an effect and it becomes part of the move, traced with the call,
before the machine sees the event. The agent proposes and the machine decides. Ask for more than will run, and say the
machine picks, so the agent doesn't trim the list to its own choices. Keep what later moves depend on, such as the
round budget, and show the reason through `data` on the one response it arrives on, so it is never stored. Make any
client the effect needs inside the call, so building the machine needs no key.

deep-research did both with Jev, TypeSafe's System One model, until the demo dropped the dependency. The excerpts are
the demo as it stood at commit `4a7436b`, where `demos/deep-research/judgments.ts` holds the two judgments whole; they
are kept as the example and are not in today's source.

```ts demos/deep-research/deep-research.ts@4a7436b
// The budget is judged from the question, not set by the lead: TypeSafe scores it from 1 to 10 rounds.
effect: ({ event }) => judgeMaxRounds(event.question),
actions: assign({
  question: ({ event }) => event.question,
  maxRounds: ({ event }) => event.output.rounds,
}),
```

```ts demos/deep-research/deep-research.ts@4a7436b
data: ({ context, event }) => ({
  round: context.round + 1,
  maxRounds: context.maxRounds,
  ...(event?.type === 'brief.submit' && { budget: event.output.budget }),
}),
```

**Docs:** `machines.md` § `effect`, § `data`; `runs.md` § The trace.

## Checkpoint

**Combines:** a schema on a transition or its target, and no actions.

**Why.** Some moves exist only to make the agent state what it holds before the next stretch. The contract checks the
statement; nothing keeps it, because nothing downstream reads it and the agent still has it. That isn't a missing
action. In one-value the review must name the count it was shown, and the machine stores nothing. A whole transition
can be a checkpoint, or one field: deep-research asks for the gaps as the price of another round and keeps only the
synthesis. It stays a checkpoint only while nothing reads what it carries. Once a guard, a derived schema or `data`
needs a field, keep that field.

```ts demos/one-value/one-value.ts
'review.submit': {
  target: 'done',
  description: 'The review is in.',
  // Derived from context: the count the agent sends must be the count it was shown.
  schema: ({ reports }) => z.object({ verdict: z.enum(['ok', 'redo']), count: z.literal(reports.length) }),
},
```

```ts demos/deep-research/deep-research.ts
// `gaps` is stated, not stored: naming them is the price of another round, and nothing keeps them.
schema: z.object({
  synthesis: z.string().min(80),
  gaps: z.array(z.string().min(10)).min(1),
}),
```

**Docs:** `machines.md` § `schema`; `style.md` § `store-nothing-unread`.
