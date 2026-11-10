# Checking a machine's style

A machine that builds is correct: everything that would mislead an agent is refused when the machine is built
([`machines.md`](./machines.md)). Whether it reads well is a second question, and `node cli.ts lint` answers the part
of it a walk over the built machine can establish exactly. That part is four rules. This page states each one, why it
holds, and what `lint` can and can't check of it.

## Running it

From inside the project, run `node cli.ts lint [<machine>...]`. It lints every machine in the catalog the project's `cli.ts` names, and every machine each one spawns, which it names
after its parent and its key in the `actors` roster, like `deep-research > researchTask`. Naming machines lints only
those and what they spawn, and a name that isn't in the catalog is an error.

A finding is a **fact**, not a verdict. It says what is exactly true of the machine, then the rule it bears on and why
that rule holds, so it explains itself without a trip to this page:

```ts packages/backseat-ai/src/cli/human.ts
lines.push(`  ${finding.where}\n    ${finding.fact}\n    ${rule.id}: ${rule.title}\n    ${rule.why}`)
```

Whether the fact makes the machine worse is the rule's claim, and yours to weigh.

`lint` is never wrong. A check that can't see enough to be exact **declines**: it reports nothing, and says it didn't
run and why. When nothing is found it prints how many machines it linted, as in `nothing to say about 1 machine`,
after anything that declined, so silence means checked. `lint` exits 1 when it found anything, and 0 when it found
nothing, even if something declined.

There is no way to silence a finding. `lint` reads the built machine, not its source, so a suppression could only be a
key on the machine, and every key on a machine means something to an agent. If you disagree with a rule, change the
rule.

## The rules

The rules live in `packages/backseat-ai/src/runtime/style-rules.json`, and a finding prints its rule's `id`, `title`
and `why` from there.

### `data-only-across-readers`

```json packages/backseat-ai/src/runtime/style-rules.json
{
  "id": "data-only-across-readers",
  "title": "`data` only where the reader is not the writer",
  "why": "A driver holds its whole conversation, so publishing back a value it already sent is noise it has to read past. `data` earns its place when the reader is not the writer: a child's driver reading what its parent set, or a value the machine itself computed."
}
```

Context is hidden from the driver, and [`data`](./machines.md#data) is the one way a value reaches it. Publishing back
what the same driver sent a call ago says it twice. `data` earns its place when the reader didn't write it: a spawned
child's driver reading what its parent set, or a value the machine computed itself.

**What `lint` checks.** For each state with `data`, it takes the transitions every path from the initial state must
have taken to get there. A `data` key that one of those transitions' schemas carries is a finding: the driver here has
already sent it.

**It can't see repackaging.** A `data` value assembled from fields the driver sent under other names matches no key.

**It declines** on a machine that spawns, since a child's driver may not hold what this one does, and on a machine with
a parallel node. It also declines for a state whose `data` throws on the context the machine was built with.

### `bound-every-loop`

```json packages/backseat-ai/src/runtime/style-rules.json
{
  "id": "bound-every-loop",
  "title": "Bound every loop, and open a door at the bound",
  "why": "An agent that cannot finish in five rounds will not finish in fifty, and closing the loop without an exit strands it in a state with nothing it can send. The way out opens as the way round shuts."
}
```

A cycle with no limit can go round forever. Closing it at the limit isn't enough on its own, because that leaves the
agent in a state with nothing it can send. The way out opens as the way round shuts, on complementary guards, and it
carries what's still unresolved so the run ends saying what's wrong. In the pr-review demo, `review.concerns` goes
round again on one guard and `review.exhausted` ends the run on its complement:

```ts demos/pr-review/pr-review.ts
const MAX_ROUNDS = 5
const withinBudget = ({ context }: { context: PrReviewContext }) => context.rounds < MAX_ROUNDS
const budgetSpent = ({ context }: { context: PrReviewContext }) => context.rounds >= MAX_ROUNDS
```

**What `lint` checks.** A set of states the machine can cycle through with no transition leaving the set, or a state
whose only transitions lead back to itself.

**It can't check the guards.** Whether the way out opens exactly as the way round shuts needs the guards, and they're
functions.

**It declines** on a machine with a parallel node, where what's stuck is a set of states rather than one.

### `spend-the-last-word`

```json packages/backseat-ai/src/runtime/style-rules.json
{
  "id": "spend-the-last-word",
  "title": "A final state's instructions are the last thing the agent reads",
  "why": "Arriving at a final state delivers its instructions and closes the actor, so nothing can be said after them. Spend them on the act that closes the work out; endings split to record a distinction should not share one form of words."
}
```

Arriving at a final state hands over its instructions and closes the actor, so they're the one piece of prose with no
next call behind it. Spend them on the act that closes the work out, which is usually outside the machine: approve,
comment, report. Different endings should close out differently. An ending reached by running out of rounds mustn't
read as approval.

**What `lint` checks.** Two things, on the root's final states that some transition reaches: a final state with no
instructions, and two or more final states whose instructions are the same string. A final state inside a compound
state isn't checked, since its parent's `onDone` moves on at once and the agent never reads it.

**It declines** to compare instructions written as functions, since two can agree on the context the machine was built
with and differ in a live run.

### `store-nothing-unread`

```json packages/backseat-ai/src/runtime/style-rules.json
{
  "id": "store-nothing-unread",
  "title": "Store nothing in context that nothing reads",
  "why": "The agent already holds the value it sent, so a copy nothing reads buys nothing. It makes the run record look as though the machine depends on a fact it never uses."
}
```

A context field nothing reads buys nothing, and it tells the next reader the machine depends on it. Delete it, or give
it a reader on purpose. A transition with no actions isn't missing anything: its whole work is that the agent holds
what the next stretch needs.

**What `lint` checks.** A context field that no reader names. The readers it looks in are guards, schemas built from
context, `data`, `instructions` written as functions, `effect` and the root's `output`. It reads their source text
with strings and comments stripped, so a field named in a sentence doesn't count as read.

**It can't see every reader.** A spawn's `id`, `input` and `about`, and any ordinary action, read context too, and
`lint` doesn't look in them. On a machine that spawns, check a finding yourself before you act on it.

**It declines** when a reader calls a function whose body the built machine doesn't carry, since a field read only in
there would look unread. Hoisting the logic into the reader itself lets the check run.

## When every check declines

`lint` builds the machine's initial snapshot, from its `sampleInput` if it has one, to know its context. If that
snapshot can't be computed, every check declines with the reason.
