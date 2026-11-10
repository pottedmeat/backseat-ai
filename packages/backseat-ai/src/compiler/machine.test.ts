import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, beforeAll, vi } from 'vitest'
import { assign, createActor, spawnChild } from 'xstate'
import { z } from 'zod'
import { createRuntime, memoryStore, RejectedEvent } from '../runtime/index.js'
import type { Rejection, Summary } from '../runtime/index.js'
import { backseat, collectChildren } from './machine.js'
import { lead, worker } from '../../../../demos/one-value/one-value.js'
import { reader, shelf } from '../../../../demos/one-value/effects.js'
import { researchTask } from '../../../../demos/deep-research/research-task.js'

// The one-value surface has two claims. The runtime's claim: what `backseat().createMachine` lowers is read by
// the runtime at the same fixed paths the JSON compiler produced, so the runtime does not move — proved by driving
// the fixture through `createRuntime` untouched. The author's claim: a mistake in the value is a compile error naming
// the mistake, from a consumer package under `nodenext` + `skipLibCheck` — proved by compiling one deliberately broken
// copy of the fixture per mistake and pinning the first line `tsc` prints.

const leaky = backseat<{ n: number }, { type: 'go' }>()

describe('the lowered machine is what the runtime reads', () => {
  it('moves first-class keys under meta at the paths the runtime dereferences, and nowhere else', () => {
    // node.meta.instructions / .data / .sites — `sites` built from `spawn`, keyed by the roster name
    const dispatching = lead.getStateNodeById('lead.dispatching')
    expect(dispatching.meta).toMatchObject({ sites: [{ src: 'worker' }] })
    // `data` and, here, `instructions` are carried as declared; the runtime resolves them against context where it reads them
    expect(typeof dispatching.meta?.['data']).toBe('function')
    expect(typeof dispatching.meta?.['instructions']).toBe('function')
    // `instructions` is a string or a function of the visit, never an object: the worker's differ between arrivals,
    // so they are the function form, and both arrivals are carried as declared for the runtime to resolve.
    const working = worker.getStateNodeById('worker.working').meta?.['instructions'] as (args: { context: unknown; visit: string }) => string
    expect(typeof working).toBe('function')
    expect(working({ context: { item: 'x' }, visit: 'first' })).toContain('data.item')
    expect(working({ context: { item: 'x' }, visit: 'revisit' })).toContain('Still on')
    // the spawn is an entry action, first, so the child exists before any authored entry runs — and the note that
    // resolves its `about` follows it, close enough that the two read the same context
    expect(dispatching.entry.length).toBe(2)
    // transition.meta.settled, and ADR-0008's action list: the settle actions, the transition's own, then stopCollected
    const contest = dispatching.transitions.get('item.next')!
    expect(contest).toHaveLength(2)
    expect(contest[1]!.meta).toMatchObject({ settled: [{ state: 'dispatching', src: 'worker' }] })
    expect(contest[1]!.actions).toHaveLength(2)
    expect(contest[0]!.meta).toBeUndefined()
    // node.meta.schema, as a function of context
    expect(typeof lead.getStateNodeById('lead.reviewing').transitions.get('review.submit')![0]!.meta?.['schema']).toBe('function')
    // the sample input rides the context initializer onto the root's meta; the roster lands in implementations, which is where registration walks
    expect(worker.root.meta).toEqual({ sampleInput: { item: 'sample' } })
    // the site was read back off the spawnChild action rather than declared: the action carries its own src
    const spawn = dispatching.entry[0] as unknown as { type: string; src: string }
    expect([spawn.type, spawn.src]).toEqual(['xstate.spawnChild', 'worker'])
    expect(lead.root.meta).toBeUndefined()
    expect(lead.implementations.actors['worker']).toBe(worker)
    // the tracking hook is on the root, so the runtime's own registration check passes without the author writing it
    expect(lead.root.transitions.has('agent.presented')).toBe(true)
  })

  it('is driven by the runtime as the JSON-compiled machines were: spawn, gate on settled, context-derived schema', async () => {
    let n = 0
    const rt = createRuntime({ machines: { lead }, store: memoryStore(), createId: () => `r${++n}` })
    const created = await rt.create('lead')
    expect(created.state.map((s) => s.id)).toEqual(['briefing'])
    expect(created.targets.map((t) => t.id)).toEqual(['dispatching'])

    // the spawn site: one worker per item, filed under the site by the roster name the child was spawned with
    const first = (await rt.send('r1', { type: 'brief.submit', items: ['a', 'b'] })) as Summary
    expect(first.state[0]!.id).toBe('dispatching')
    expect(first.data).toEqual({ current: 'a', remaining: 1 })
    // `about` is the lead's note, not the worker's input: it counts what is still queued, which the worker is never told
    expect(first.children).toEqual([{ id: 'r1/w-a', about: 'item "a", 1 still queued' }])
    // the contest: while items remain only the reentering branch is offered
    expect(first.targets.map((t) => t.id)).toEqual(['dispatching'])

    const second = (await rt.send('r1', { type: 'item.next' })) as Summary
    expect(second.data).toEqual({ current: 'b', remaining: 0 })
    expect(second.children).toEqual([{ id: 'r1/w-b', about: 'item "b", 0 still queued' }]) // the child this call spawned; the gate below lists both
    // …and once none remain, the gated branch is the only one left, and it is not offered while the workers run, so
    // nothing is listed: a move not offered now is not shown (ADR-0008)
    expect(second.targets).toEqual([])

    // the gate: with workers still running the event is refused and names what must settle
    const refused = (await rt.send('r1', { type: 'item.next' })) as Rejection
    expect(refused.rejected).toBe(true)
    expect(refused.reason).toBe('pending-children')
    expect(refused.pending).toEqual([{ state: 'dispatching', src: 'worker', children: ['r1/w-a', 'r1/w-b'] }])

    // a worker is driven by its own id, through the same surface
    const done = (await rt.send('r1/w-a', { type: 'finish', note: 'n1' })) as Summary
    expect(done.status).toBe('done')
    await rt.send('r1/w-b', { type: 'finish', note: 'n2' })
    // every worker is back: the gated branch is offered now, with the requirement spelled out
    expect((await rt.snapshot('r1')).targets).toEqual([{ id: 'reviewing', description: 'Every worker is back.', events: [{ type: 'item.next', description: 'Nothing left to dispatch.', requires: 'every child spawned at dispatching (worker) settled', schema: '{}' }] }])

    // the collection reaches the settle action as `event.settled`, and the context-derived schema reads what it wrote
    const reviewing = (await rt.send('r1', { type: 'item.next' })) as Summary
    expect(reviewing.state[0]!.id).toBe('reviewing')
    expect(reviewing.data).toEqual({ reports: [{ item: 'a', note: 'n1' }, { item: 'b', note: 'n2' }] })
    expect(reviewing.children).toEqual([]) // the gate stopped what it collected
    expect(reviewing.targets[0]!.events[0]!.schema).toContain('count: 2')
    const wrongCount = (await rt.send('r1', { type: 'review.submit', verdict: 'ok', count: 1 })) as Rejection
    expect(wrongCount.reason).toBe('invalid-payload')
    const finished = (await rt.send('r1', { type: 'review.submit', verdict: 'ok', count: 2 })) as Summary
    expect(finished.status).toBe('done')
  })

  it('refuses at the call what the types cannot see: a spawn site no transition requires settled', () => {
    // `checkSites` runs inside `createMachine`, so a machine whose workers' results would be silently discarded never exists
    expect(() =>
      leaky.createMachine({
        id: 'leaky',
        description: 'Spawns and never collects.',
        actors: { worker },
        context: { n: 0 },
        initial: 'a',
        states: {
          a: { description: 'A.', entry: spawnChild('worker', { id: 'w', input: { item: 'x' } }), on: { go: { target: 'b' } } },
          b: { description: 'B.', type: 'final' },
        },
      }),
    ).toThrow(/leaky: spawning: .*'worker'.*settled/s)
  })

  it("takes XState's own spawnChild and Backseat's alike, reading the same site off both", () => {
    // The fixture's lead uses Backseat's; this one imports XState's. Both are XState's action, so lowering reads the
    // site off either — the only difference is that XState's infers nothing about `context` at a bare call site.
    const mine = leaky.createMachine({
      id: 'mine',
      description: 'Spawns with XState\'s own spawnChild.',
      actors: { worker },
      context: { n: 0 },
      initial: 'a',
      states: {
        a: { description: 'A.', entry: spawnChild('worker', { id: 'w', input: { item: 'x' } }), on: { go: { target: 'b', actions: collectChildren('a', 'worker') } } },
        b: { description: 'B.', type: 'final' },
      },
    })
    expect(mine.getStateNodeById('mine.a').meta).toMatchObject({ sites: [{ src: 'worker' }] })
    expect(lead.getStateNodeById('lead.dispatching').meta).toMatchObject({ sites: [{ src: 'worker' }] })
  })

  it("refuses XState's own spawnChild without an id, which would file every child under \"undefined\"", () => {
    // The typed spawnChild requires one; XState's does not, so a second child spawned here would replace the first and
    // leave it running, held by nothing. Only lowering sees XState's.
    expect(() =>
      leaky.createMachine({
        id: 'anon',
        description: 'Spawns a child with no id.',
        actors: { worker },
        context: { n: 0 },
        initial: 'a',
        states: {
          a: { description: 'A.', entry: spawnChild('worker', { input: { item: 'x' } }), on: { go: { target: 'b', actions: collectChildren('a', 'worker') } } },
          b: { description: 'B.', type: 'final' },
        },
      }),
    ).toThrow("anon: states.a.entry: spawnChild('worker') has no id.")
  })

  it('resolves instructions declared as a function, telling it which arrival this is', async () => {
    let n = 0
    const rt = createRuntime({ machines: { lead }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('lead')
    const first = (await rt.send('r1', { type: 'brief.submit', items: ['a', 'b'] })) as Summary
    // first arrival: the `first` branch, whatever context says
    expect(first.state[0]!.instructions).toContain('Move on to the next item')  // visit: 'first'
    // revisited with an item still queued, and then with none: the same declaration, two different texts
    const second = (await rt.send('r1', { type: 'item.next' })) as Summary
    expect(second.state[0]!.instructions).toBe('Nothing left to dispatch; move on to the review.')  // visit: 'revisit', items now empty
  })

  it('files a spawn in an object-form initial at the region it opens, so those children are announced, gated and collected', async () => {
    // Lowering reads sites off the actions it visits. Were `initial.actions` not among them, this `collectChildren`
    // would name a site that does not exist, and a machine without it would drop the worker's output in silence.
    const { createMachine, spawnChild: spawnWorker } = backseat<{ n: number }, { type: 'start' } | { type: 'go' }>()
    const deflt = createMachine({
      id: 'deflt',
      description: 'Opens a region that spawns its worker on default entry.',
      actors: { worker },
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: { description: 'Nothing open.', on: { start: { target: 'group', description: 'Open the region.' } } },
        group: {
          description: 'The region.',
          initial: { target: 'a', actions: spawnWorker('worker', { id: 'w', input: { item: 'x' }, about: { opened: 'group' } }) },
          on: { go: { target: 'done', description: 'The worker is back.', actions: collectChildren('group', 'worker') } },
          states: { a: { description: 'Inside the region.' } },
        },
        done: { description: 'Done.', type: 'final' },
      },
    })
    expect(deflt.getStateNodeById('deflt.group').meta).toMatchObject({ sites: [{ src: 'worker' }] })

    let n = 0
    const rt = createRuntime({ machines: { deflt }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('deflt')
    const opened = (await rt.send('r1', { type: 'start' })) as Summary
    expect(opened.children).toEqual([{ id: 'r1/w', about: { opened: 'group' } }])
    const refused = (await rt.send('r1', { type: 'go' })) as Rejection
    expect(refused.pending).toEqual([{ state: 'group', src: 'worker', children: ['r1/w'] }])
    await rt.send('r1/w', { type: 'finish', note: 'n1' })
    const done = (await rt.send('r1', { type: 'go' })) as Summary
    expect(done.status).toBe('done')
  })

  it('throws at the call when spawnChild names a machine that is not on the roster, and says what is', () => {
    expect(() =>
      leaky.createMachine({
        id: 'stray',
        description: 'Spawns something it does not carry.',
        actors: { worker },
        context: { n: 0 },
        initial: 'a',
        states: {
          a: { description: 'A.', entry: spawnChild('workr', { id: 'w' }), on: { go: { target: 'b', actions: collectChildren('a', 'worker') } } },
          b: { description: 'B.', type: 'final' },
        },
      }),
    ).toThrow("stray: states.a.entry: spawnChild('workr') names no machine on this one's roster, which holds 'worker'")
  })

  // `meta` is XState's place for an author's own annotations, read back through `getMeta()`. Lowering writes Backseat's
  // keys beside them rather than over them — before, a state's `meta` was replaced whole — and refuses a key the runtime
  // would obey without the surface that writes it: a hand-written `settled` gates a transition that stops nothing.
  it("carries the author's own meta through beside Backseat's keys, and refuses a key that is Backseat's", () => {
    const annotated = leaky.createMachine({
      id: 'annotated',
      description: 'Carries its own meta.',
      meta: { owner: 'ops' },
      context: { n: 0 },
      initial: 'a',
      states: {
        a: { description: 'A.', instructions: 'Send go.', meta: { label: 'Start' }, on: { go: { target: 'b', instructions: 'Done.', meta: { tracked: true } } } },
        b: { description: 'B.', type: 'final' },
      },
    })
    expect(annotated.root.meta).toEqual({ owner: 'ops' })
    expect(annotated.getStateNodeById('annotated.a').meta).toEqual({ label: 'Start', instructions: 'Send go.' })
    expect(annotated.getStateNodeById('annotated.a').transitions.get('go')![0]!.meta).toEqual({ tracked: true, instructions: 'Done.' })
    expect(createActor(annotated).getSnapshot().getMeta()['annotated.a']?.['label']).toBe('Start')
    expect(() =>
      leaky.createMachine({
        id: 'forged',
        description: 'Writes a gate by hand.',
        context: { n: 0 },
        initial: 'a',
        states: {
          a: { description: 'A.', on: { go: { target: 'b', meta: { settled: [] } as never } } },
          b: { description: 'B.', type: 'final' },
        },
      }),
    ).toThrow("forged: states.a.on.go.meta: 'settled' under meta is Backseat's to write: a transition is gated by collectChildren in its actions")
  })

  // Registration builds the initial snapshot with `{}` unless the initializer carries a sample, so an initializer that
  // reads its input fails with a TypeError about `undefined` that says nothing of the fix. The fix is ours to name.
  it('names withCheckInput when an initializer that reads its input fails without a sample, and builds once given one', () => {
    const b = backseat<{ upper: string }, { type: 'go' }, { dir: string }>()
    const needsInput = (context: (args: { input: { dir: string } }) => { upper: string }) =>
      b.createMachine({ id: 'needs', description: 'Reads its input.', context, initial: 'a', states: { a: { description: 'A.' } } })
    const initializer = ({ input }: { input: { dir: string } }) => ({ upper: input.dir.toUpperCase() })
    expect(() => needsInput(initializer)).toThrow(/needs: context: .*could not compute the initial snapshot.*\n.*withCheckInput/s)
    expect(() => needsInput(b.withCheckInput(initializer, { dir: 'x' }))).not.toThrow()
  })
})

// ---- what the author sees when they get it wrong ------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const consumer = join(root, 'demos/one-value')
const flags = ['--noEmit', '--ignoreConfig', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--pretty', 'false']

/** First line `tsc` prints for `file`, compiled alone from the consumer package, with its position stripped. */
function firstError(file: string): string | undefined {
  try {
    execFileSync(join(consumer, 'node_modules/.bin/tsc'), [...flags, file], { cwd: consumer, encoding: 'utf8' })
    return undefined
  } catch (error) {
    const stdout = (error as { stdout: string }).stdout
    return stdout
      .split('\n')
      .filter((line) => line.startsWith(file))
      .map((line) => line.replace(/^.*?\(\d+,\d+\): /, ''))[0]
  }
}

/** One mistake per case: what is replaced in the fixture, and the first line the author reads for it. */
const mistakes: Array<[name: string, from: string, to: string, expected: string]> = [
  ['a misspelled target', "target: 'reviewing',", "target: 'reviewng',", `error TS2820: Type '"reviewng"' is not assignable to type '"briefing" | "dispatching" | "done" | "reviewing" | undefined'. Did you mean '"reviewing"'?`],
  ['a misspelled initial', "initial: 'briefing',", "initial: 'briefng',", `error TS2820: Type '"briefng"' is not assignable to type '"briefing" | "dispatching" | "done" | "reviewing" | undefined'. Did you mean '"briefing"'?`],
  ["a payload field the transition's event does not carry", 'items: event.items,', 'items: event.item,', `error TS2551: Property 'item' does not exist on type '{ type: "brief.submit"; items: string[]; }'. Did you mean 'items'?`],
  ['a misspelled target inside a contest', "target: 'dispatching', reenter", "target: 'dispatchng', reenter", `error TS2820: Type '"dispatchng"' is not assignable to type '"briefing" | "dispatching" | "done" | "reviewing" | undefined'. Did you mean '"dispatching"'?`],
  ["a misspelled first-class key on a state, which XState's own createMachine accepts silently", "instructions: 'Hand over the list", "instructinos: 'Hand over the list", `error TS2322: Type 'string' is not assignable to type 'NotAKeyOfABackseatState<"instructinos">'.`],
  ['a misspelled key on a transition', 'reenter: true,', 'reentre: true,', `error TS2322: Type 'boolean' is not assignable to type 'NotAKeyOfABackseatTransition<"reentre">'.`],
  ['a misspelled event key', "'review.submit': {", "'review.sumbit': {", `error TS2353: Object literal may only specify known properties, and 'target' does not exist in type 'NotAnEventThisMachineDeclares<"review.sumbit">'.`],
  // The same mistake with a correct key still beside it, which is the form that once compiled completely clean: the
  // excess-property check only fired once the state had no valid key left, so every real typo — made in a
  // state that handles more than one event — was accepted and lowered.
  ['a misspelled event key with a valid one still beside it', "'review.submit': {", "'review.sumbit': { description: 'The review is in.' },\n        'review.submit': {", `error TS2353: Object literal may only specify known properties, and 'description' does not exist in type 'NotAnEventThisMachineDeclares<"review.sumbit">'.`],
  ["a misspelled XState key on a state, which XState's own createMachine also accepts silently once the state has an `on`", "type: 'final', description: 'Reviewed.'", "tpye: 'final', description: 'Reviewed.'", `error TS2322: Type 'string' is not assignable to type 'NotAKeyOfABackseatState<"tpye">'.`],
  ['an action given by name rather than as a value', 'actions: assign(pullNext)', "actions: 'pullNext'", `error TS2322: Type 'string' is not assignable to type 'Action<LeadContext, { type: "item.next"; }, LeadEvent> | (Action<LeadContext, { type: "item.next"; }, LeadEvent> | Collect<...>)[] | Collect<...> | undefined'.`],
  ['a collected action reading the collection off the wrong key', 'event.settled.flatMap', 'event.setled.flatMap', `error TS2551: Property 'setled' does not exist on type '{ type: "item.next"; } & { settled: Collection[]; }'. Did you mean 'settled'?`],
  // `checkInput` rode on the root before it moved onto the initializer; a value still carrying it is told so by name.
  ['a sample input written as a root key rather than on the initializer', "context: withCheckInput(({ input }) => ({ item: input.item, note: null }), { item: 'sample' }),", "context: ({ input }) => ({ item: input.item, note: null }),\n  checkInput: { item: 'sample' },", `error TS2353: Object literal may only specify known properties, and 'item' does not exist in type 'NotAKeyOfABackseatState<"checkInput">'.`],
  ["a key under meta that is Backseat's to write, which the runtime would obey without the surface that writes it", 'reenter: true,', "meta: { instructions: 'Go on.' }, reenter: true,", `error TS2322: Type 'string' is not assignable to type 'ReservedForBackseat<"instructions">'.`],
  ['a spawn callback reading a field context does not have', 'context.current ?? ', 'context.curent ?? ', `error TS2551: Property 'curent' does not exist on type 'LeadContext'. Did you mean 'current'?`],

  // The four spellings of an `on` key no agent can send, refused under ADR-0008. Each is written beside a valid
  // key, because that is the form the surface used to accept: what a machine handles must be what its driver can send,
  // and any of these moves the actor while that driver is away. `EventDescriptor<E>` contributes the two wildcards
  // whatever the event union says, so all four are refused on the key rather than on the event type.
  ['a catch-all key, which also swallows an ancestor\'s onDone', "'review.submit': {", "'*': { description: 'Anything at all.' },\n        'review.submit': {", `error TS2353: Object literal may only specify known properties, and 'description' does not exist in type 'NotAnEventAnAgentCanSend<"*">'.`],
  ['a partial catch-all key', "'review.submit': {", "'review.*': { description: 'Any review event.' },\n        'review.submit': {", `error TS2353: Object literal may only specify known properties, and 'description' does not exist in type 'NotAnEventAnAgentCanSend<"review.*">'.`],
  ["a spawned child's done event, the door the ban was written for and walked in through", "'review.submit': {", "'xstate.done.actor.*': { description: 'A worker finished.' },\n        'review.submit': {", `error TS2353: Object literal may only specify known properties, and 'description' does not exist in type 'NotAnEventAnAgentCanSend<"xstate.done.actor.*">'.`],
  ["a spawned child's error event, which the runtime absorbs on the root so a crash is collected rather than fatal", "'review.submit': {", "'xstate.error.actor.*': { description: 'A worker broke.' },\n        'review.submit': {", `error TS2353: Object literal may only specify known properties, and 'description' does not exist in type 'NotAnEventAnAgentCanSend<"xstate.error.actor.*">'.`],
  ["the runtime's own reserved space", "'review.submit': {", "'agent.presented': { description: 'Mine now.' },\n        'review.submit': {", `error TS2353: Object literal may only specify known properties, and 'description' does not exist in type 'NotAnEventAnAgentCanSend<"agent.presented">'.`],
]

beforeAll(() => {
  // The consumer resolves `backseat-ai` through its `exports` to `dist/`, so the published types are what is
  // being measured — including that they survive `nodenext` + `skipLibCheck` (typed-builders research). At the
  // file's top level, because both negative suites need it and either may be run on its own. The negatives are emptied
  // first, so a renamed or removed case leaves no stale copy behind to be read as the current surface. This run is the
  // only gate on the pinned diagnostics: `pnpm typecheck` checks the fixtures compile, never what a broken one prints.
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-b', 'packages/backseat-ai'], { cwd: root, stdio: 'inherit' })
  rmSync(join(consumer, 'negatives'), { recursive: true, force: true })
  mkdirSync(join(consumer, 'negatives'), { recursive: true })
}, 60_000)

describe('what the author sees when they get it wrong, compiled from a consumer package', () => {
  const fixture = readFileSync(join(consumer, 'one-value.ts'), 'utf8')

  it('the fixture itself compiles with no error at all — the canary for every loss of contextual typing (TS7031)', () => {
    expect(firstError('one-value.ts')).toBeUndefined()
  }, 30_000)

  for (const [i, [name, from, to, expected]] of mistakes.entries()) {
    it(`names ${name}`, () => {
      expect(fixture.split(from)).toHaveLength(2) // the replacement lands in exactly one place
      const file = `negatives/n${String(i + 1).padStart(2, '0')}.ts`
      writeFileSync(join(consumer, file), fixture.replace(from, to))
      expect(firstError(file)).toBe(expected)
    }, 30_000)
  }
})

/**
 * The doors a `target` is written through besides `on` and `always`. Three of these once compiled clean, which is how an earlier author came to believe grouped states were unusable and flattened `deep-research`'s
 * `citing`: the checked door taught one rule and the unchecked door obeyed another. The last four rows are the root,
 * where no door takes a target, and a node's own `target`, which only a history state has.
 *
 * A second fixture, because `doors.ts` is authoring-only while `one-value.ts` is also driven through `createRuntime`,
 * and two of the rows below pin the sibling union that fixture prints. A row carries a list of edits rather than one
 * pair: refusing a collected action on an `onDone` takes an import as well as the action.
 */
const doorMistakes: Array<[name: string, edits: Array<[from: string, to: string]>, expected: string]> = [
  [
    'a misspelled `onDone` target — the door `deep-research` actually uses, which threw on import before this',
    [["target: 'resting'", "target: 'restng'"]],
    `error TS2820: Type '"restng"' is not assignable to type '"idle" | "resting" | "rounding" | undefined'. Did you mean '"resting"'?`,
  ],
  [
    'a misspelled key on an `onDone`',
    [["description: 'The round closed.'", "descriptoin: 'The round closed.'"]],
    `error TS2322: Type 'string' is not assignable to type 'NotAKeyOfABackseatTransition<"descriptoin">'.`,
  ],
  [
    'a `schema` on an `onDone`, which nothing sends and lowering never lifted',
    [["onDone: { target: 'resting'", "onDone: { schema: z.object({}), target: 'resting'"]],
    `error TS2741: Property '__backseat__' is missing in type 'ZodObject<{}, $strip>' but required in type 'NotAKeyOfABackseatTransition<"schema">'.`,
  ],
  [
    'an `instructions` on an `onDone`, which no agent is there to read',
    [["onDone: { target: 'resting'", "onDone: { instructions: 'Go on then.', target: 'resting'"]],
    `error TS2322: Type 'string' is not assignable to type 'NotAKeyOfABackseatTransition<"instructions">'.`,
  ],
  [
    'a collected action on an `onDone`, which lowering would never have unwrapped',
    [
      ["import { backseat } from 'backseat-ai'", "import { backseat, collectChildren } from 'backseat-ai'"],
      ['actions: assign({ rounds: ({ context }) => context.rounds + 1 })', "actions: collectChildren('rounding', 'worker')"],
    ],
    `error TS2322: Type 'Collect<MachineContext, EventObject, EventObject>' is not assignable to type 'Action<Ctx, DoneStateEvent<unknown>, Ev> | Action<Ctx, DoneStateEvent<unknown>, Ev>[] | undefined'.`,
  ],
  [
    "the bare-string `onDone` XState allows, refused here as it already is on `on` and `always`",
    [["onDone: { target: 'resting', description: 'The round closed.', actions: assign({ rounds: ({ context }) => context.rounds + 1 }) },", "onDone: 'resting',"]],
    `error TS2322: Type 'string' is not assignable to type 'ExactInternalTx<"resting", "idle" | "resting" | "rounding", Ctx, Ev, DoneStateEvent<unknown>>'.`,
  ],
  [
    "a misspelled history default target — the fourth place a target is written, which an earlier fix did not know about",
    [["type: 'history', target: 'open'", "type: 'history', target: 'opn'"]],
    `error TS2820: Type '"opn"' is not assignable to type '"open" | "resumed" | "settled" | undefined'. Did you mean '"open"'?`,
  ],
  [
    'a misspelled target on a transition-object `initial`, which names a child where every other door names a sibling',
    [["initial: { target: 'open' }", "initial: { target: 'opn' }"]],
    `error TS2820: Type '"opn"' is not assignable to type '"open" | "resumed" | "settled"'. Did you mean '"open"'?`,
  ],
  [
    'a `guard` on a transition-object `initial`, which XState types and never evaluates',
    [["initial: { target: 'open' }", "initial: { target: 'open', guard: () => false }"]],
    `error TS2322: Type '() => boolean' is not assignable to type 'AnInitialTransitionRunsOnlyItsTargetAndActions<"guard">'.`,
  ],
  [
    'a collected action on a transition-object `initial`, where no agent sends anything to gate',
    [
      ["import { backseat } from 'backseat-ai'", "import { backseat, collectChildren } from 'backseat-ai'"],
      ["initial: { target: 'open' }", "initial: { target: 'open', actions: collectChildren('rounding', 'worker') }"],
    ],
    `error TS2322: Type 'Collect<MachineContext, EventObject, EventObject>' is not assignable to type 'Action<Ctx, Ev, Ev> | Action<Ctx, Ev, Ev>[] | undefined'.`,
  ],
  [
    'an `after` delay, which no process exists to fire',
    [["description: 'A round is open.',", "description: 'A round is open.',\n      after: { 1000: { target: 'resting' } },"]],
    `error TS2353: Object literal may only specify known properties, and '1000' does not exist in type 'NoTimerFiresBetweenInvocations<"after">'.`,
  ],
  [
    'an `invoke`, whose actor would re-run on every rehydration and whose result nothing reads',
    [["description: 'A round is open.',", "description: 'A round is open.',\n      invoke: { src: 'worker' },"]],
    `error TS2353: Object literal may only specify known properties, and 'src' does not exist in type 'SpawnAndCollectRatherThanInvoke<"invoke">'.`,
  ],
  [
    "a target on the root's own `on`, which typechecked against the top-level states and then threw from XState",
    [["description: 'The count starts over", "target: 'idle', description: 'The count starts over"]],
    `error TS2322: Type 'string' is not assignable to type 'WriteATargetedTransitionOnAChildState<"target">'.`,
  ],
  [
    "a target on the root's own `always`, the same throw by the other door the root has",
    [["  initial: 'idle',\n", "  initial: 'idle',\n  always: { target: 'idle' },\n"]],
    `error TS2322: Type 'string' is not assignable to type 'WriteATargetedTransitionOnAChildState<"target">'.`,
  ],
  [
    "a default `target` on the root, which is no history state and so has no default to name",
    [["  initial: 'idle',\n", "  initial: 'idle',\n  target: 'idle',\n"]],
    `error TS2322: Type 'string' is not assignable to type 'OnlyAHistoryStateHasADefaultTarget<"target">'.`,
  ],
  [
    'a default `target` on an ordinary state, which XState ignores in silence',
    [["description: 'No round has started.',", "target: 'resting', description: 'No round has started.',"]],
    `error TS2322: Type 'string' is not assignable to type 'OnlyAHistoryStateHasADefaultTarget<"target">'.`,
  ],
]

describe('the doors a target is written through, compiled from a consumer package', () => {
  const fixture = readFileSync(join(consumer, 'doors.ts'), 'utf8')

  it('the doors fixture itself compiles with no error at all', () => {
    expect(firstError('doors.ts')).toBeUndefined()
  }, 30_000)

  for (const [i, [name, edits, expected]] of doorMistakes.entries()) {
    it(`names ${name}`, () => {
      let broken = fixture
      for (const [from, to] of edits) {
        expect(fixture.split(from)).toHaveLength(2) // each edit lands in exactly one place
        broken = broken.replace(from, to)
      }
      const file = `negatives/d${String(i + 1).padStart(2, '0')}.ts`
      writeFileSync(join(consumer, file), broken)
      expect(firstError(file)).toBe(expected)
    }, 30_000)
  }
})

/**
 * What an effect's author sees. The event type is where `output` is declared, because TypeScript cannot carry an
 * effect's return type across to the sibling `actions` it types (measured, with the effect's argument annotated too):
 * declared there, the actions and `data` read it typed, and each of the ways to break that is named here.
 */
const effectMistakes: Array<[name: string, edits: Array<[from: string, to: string]>, expected: string]> = [
  [
    'a guard reading output, which it is evaluated before the effect produces',
    [["effect: ({ event }) => {\n            const text", "guard: ({ event }) => event.output.text !== '',\n          effect: ({ event }) => {\n            const text"]],
    `error TS2339: Property 'output' does not exist on type 'Omit<{ type: "note.read"; id: string; output: Note; }, "output"> & EventObject'.`,
  ],
  [
    'an effect that returns something other than the output its event declares',
    [['return { id: event.id, text }', 'return { id: event.id }']],
    `error TS2322: Type '({ event }: { context: Ctx; event: Omit<{ type: "note.read"; id: string; output: Note; }, "output">; }) => { id: string; }' is not assignable to type 'Effect<Ctx, { type: "note.read"; id: string; output: Note; }>'.`,
  ],
  [
    // The weakest line here: it names the transition, and only tsc's next line says `Property 'effect' is missing`.
    'a transition whose event declares output, written without the effect that produces it',
    [["| { type: 'done' }", "| { type: 'done'; output: number }"]],
    `error TS2322: Type '{ target: "finished"; description: string; }' is not assignable to type 'ExactTx<{ readonly target: "finished"; readonly description: "Nothing more to read."; }, "finished" | "reading", Ctx, Ev, { type: "done"; output: number; }, true>'.`,
  ],
  [
    "an effect on `always`, which no agent sends and so no call exists to run it in",
    [["    finished: { type: 'final'", "    finished: { always: { effect: () => 1 }, type: 'final'"]],
    `error TS2322: Type '() => number' is not assignable to type 'AnEffectRunsOnlyOnAnEventAnAgentSends<"effect">'.`,
  ],
]

describe('what an effect\'s author sees, compiled from a consumer package', () => {
  const fixture = readFileSync(join(consumer, 'effects.ts'), 'utf8')

  it('the effects fixture itself compiles with no error at all', () => {
    expect(firstError('effects.ts')).toBeUndefined()
  }, 30_000)

  for (const [i, [name, edits, expected]] of effectMistakes.entries()) {
    it(`names ${name}`, () => {
      let broken = fixture
      for (const [from, to] of edits) {
        expect(fixture.split(from)).toHaveLength(2) // each edit lands in exactly one place
        broken = broken.replace(from, to)
      }
      const file = `negatives/e${String(i + 1).padStart(2, '0')}.ts`
      writeFileSync(join(consumer, file), broken)
      expect(firstError(file)).toBe(expected)
    }, 30_000)
  }
})

/**
 * A transition hoisted out of the value through `transition()`. A plain `const` there has no contextual type: its
 * actions see `AnyEventObject` and the use site fails without naming any mistake, which is why the helper exists. A
 * mistake on the hoisted line is named there. One at the use site — a target, or reuse under another event — is named
 * only at the end of tsc's chain, under the structural dump, so that last line is the one pinned.
 */
const hoistedMistakes: Array<[name: string, from: string, to: string, expected: string]> = [
  ['an event the machine does not declare, on the hoisted line', "transition('bump')", "transition('bmup')", `error TS2345: Argument of type '"bmup"' is not assignable to parameter of type '"bump" | "finish" | "rest"'.`],
  ['a misspelled key, on the hoisted line', "description: 'The count goes up.'", "descriptoin: 'The count goes up.'", `error TS2561: Object literal may only specify known properties, but 'descriptoin' does not exist in type 'TxBase<string, Ctx, Ev, { type: "bump"; by: number; }, true>'. Did you mean to write 'description'?`],
  ['a payload field the event does not carry, on the hoisted line', 'context.count + event.by', 'context.count + event.bye', `error TS2339: Property 'bye' does not exist on type '{ type: "bump"; by: number; }'.`],
  ['a target that is not a sibling where the transition is used', "target: 'counting',", "target: 'countng',", `Type '"countng"' is not assignable to type '"counting" | "done" | "resting" | undefined'. Did you mean '"counting"'?`],
  ['the transition reused under an event it was not written for', 'on: { bump },', 'on: { rest: bump },', `Property 'by' is missing in type '{ type: "rest"; }' but required in type '{ type: "bump"; by: number; }'.`],
]

/** The last line of the first diagnostic tsc prints for `file`, compiled alone from the consumer package. */
function namingLine(file: string): string | undefined {
  try {
    execFileSync(join(consumer, 'node_modules/.bin/tsc'), [...flags, file], { cwd: consumer, encoding: 'utf8' })
    return undefined
  } catch (error) {
    const lines = (error as { stdout: string }).stdout.split('\n')
    const first = lines.findIndex((line) => line.startsWith(file))
    const end = lines.findIndex((line, i) => i > first && !line.startsWith(' '))
    return lines[(end === -1 ? lines.length : end) - 1]!.replace(/^.*?\(\d+,\d+\): /, '').trim()
  }
}

describe('a hoisted transition, compiled from a consumer package', () => {
  const fixture = readFileSync(join(consumer, 'hoisted.ts'), 'utf8')

  it('the hoisted fixture itself compiles with no error at all', () => {
    expect(firstError('hoisted.ts')).toBeUndefined()
  }, 30_000)

  for (const [i, [name, from, to, expected]] of hoistedMistakes.entries()) {
    it(`names ${name}`, () => {
      expect(fixture.split(from)).toHaveLength(2) // the replacement lands in exactly one place
      const file = `negatives/h${String(i + 1).padStart(2, '0')}.ts`
      writeFileSync(join(consumer, file), fixture.replace(from, to))
      expect(namingLine(file)).toBe(expected)
    }, 30_000)
  }
})

describe('a spawn says what it is for', () => {
  /** A worker that can also break, so a collection can be read with one child that never produced an output. */
  const flakyTypes = backseat<{ item: string }, { type: 'finish' } | { type: 'break' }, { item: string }>()
  const flaky = flakyTypes.createMachine({
    id: 'flaky',
    description: 'Works one item, or breaks trying.',
    context: flakyTypes.withCheckInput(({ input }) => ({ item: input.item }), { item: 'sample' }),
    output: ({ context }) => ({ item: context.item }),
    initial: 'working',
    states: {
      working: {
        description: 'The item is being worked.',
        instructions: 'Work `data.item`.',
        data: ({ context: { item } }) => ({ item }),
        on: {
          finish: { target: 'done', description: 'Finish it.' },
          break: {
            description: 'Break.',
            actions: () => {
              throw new Error('the worker broke')
            },
          },
        },
      },
      done: { type: 'final', description: 'The item is finished.' },
    },
  })

  type QC = { queue: string[]; current: string | null; reports: unknown[] }
  type QE = { type: 'go' } | { type: 'review' }
  const b = backseat<QC, QE>()
  const pull = ({ context }: { context: QC }) => ({ current: context.queue[0] ?? null, queue: context.queue.slice(1) })

  /**
   * The spawn and the `assign` that moves the queue on sit in **one entry list**, which is the shape a probe
   * warned about: resolving `about` when the child is *filed* rather than at the spawn labels every child with the
   * next one's work. The `about` here reads `queue[0]` — exactly what the line below it drops.
   */
  const queued = b.createMachine({
    id: 'queued',
    description: 'Spawns a worker per queued item.',
    actors: { worker: flaky },
    context: { queue: ['a', 'b'], current: null, reports: [] },
    initial: 'idle',
    states: {
      idle: { description: 'Waiting to start.', on: { go: { target: 'working', description: 'Start.', actions: assign(pull) } } },
      working: {
        description: 'A worker is out.',
        entry: [
          b.spawnChild('worker', {
            id: ({ context }) => `w-${context.current}`,
            input: ({ context }) => ({ item: context.current ?? '' }),
            about: ({ context }) => ({ working: context.current, next: context.queue[0] ?? null }),
          }),
          assign(pull),
        ],
        on: {
          go: { target: 'working', reenter: true, description: 'Another item is waiting.' },
          review: {
            target: 'reviewing',
            description: 'Every worker is back.',
            actions: collectChildren(
              'working',
              'worker',
              assign({ reports: ({ event }) => event.settled.flatMap((site) => site.children.map((child) => ({ status: child.status, about: child.about, output: child.output }))) }),
            ),
          },
        },
      },
      reviewing: { description: 'Reading what came back.', data: ({ context: { reports } }) => ({ reports }) },
    },
  })

  const driver = () => {
    let n = 0
    return createRuntime({ machines: { queued }, store: memoryStore(), createId: () => `r${++n}` })
  }

  it("resolves about at the spawn, not at the filing, so a child is never labelled with the next one's work", async () => {
    const rt = driver()
    await rt.create('queued')
    // At this spawn the queue still holds both: this child is working 'a', and 'b' is what comes after it.
    const first = (await rt.send('r1', { type: 'go' })) as Summary
    expect(first.children).toEqual([{ id: 'r1/w-a', about: { working: 'a', next: 'b' } }])
    // The `assign` below the spawn has since dropped 'a'. Read now, this child would claim to be working 'b'.
    const second = (await rt.send('r1', { type: 'go' })) as Summary
    expect(second.children).toEqual([{ id: 'r1/w-b', about: { working: 'b', next: null } }])
  })

  it('carries about into the collection, so a worker that broke still says what it was for', async () => {
    const rt = driver()
    await rt.create('queued')
    await rt.send('r1', { type: 'go' })
    await rt.send('r1', { type: 'go' })
    await rt.send('r1/w-a', { type: 'finish' })
    const broke = await rt.send('r1/w-b', { type: 'break' })
    expect(broke.status).toBe('error')

    const reviewing = (await rt.send('r1', { type: 'review' })) as Summary
    expect(reviewing.data).toEqual({
      reports: [
        { status: 'done', about: { working: 'a', next: 'b' }, output: { item: 'a' } },
        // No output at all, and the child is gone: `about` is the only thing left that says what it was for.
        { status: 'error', about: { working: 'b', next: null }, output: undefined },
      ],
    })
  })

  it('never hands about to the child: the child gets input, and answers about itself', async () => {
    const rt = driver()
    await rt.create('queued')
    await rt.send('r1', { type: 'go' })
    const child = await rt.snapshot('r1/w-a')
    // The worker projects from the input it was given. The parent's note is on neither its context nor its response,
    // and a parent wanting to know what a child is working on asks the child, which is what this answers.
    expect(child.data).toEqual({ item: 'a' })
    expect(JSON.stringify(child)).not.toContain('next')
  })

  it('announces a child once, and repeats nothing about it afterwards', async () => {
    const rt = driver()
    await rt.create('queued')
    const spawned = (await rt.send('r1', { type: 'go' })) as Summary
    expect(spawned.children).toHaveLength(1)
    // Every later look at the parent while that child is still running carries nothing about it.
    expect((await rt.snapshot('r1')).children).toBeUndefined()
    expect(JSON.stringify(await rt.snapshot('r1'))).not.toContain('w-a')
  })
})

// A collecting transition is the one place where failing is expensive: the runtime has already copied each child's
// outcome into the run record, and `stopCollected` — appended last by lowering — is what makes "settled" literally
// true. XState discards a whole transition when any action throws, so that stop never runs. The errored
// snapshot used to be persisted anyway, which left the children flagged collected but never stopped: live actors under a
// dead root, their outputs in a record the machine could no longer reach.
describe('an action that throws inside a collection', () => {
  const settlingTypes = backseat<{ item: string }, { type: 'finish' }, { item: string }>()
  const settling = settlingTypes.createMachine({
    id: 'settling',
    description: 'One item of work.',
    context: settlingTypes.withCheckInput(({ input }) => ({ item: input.item }), { item: 'sample' }),
    output: ({ context }) => ({ item: context.item }),
    initial: 'working',
    states: {
      working: { description: 'Being worked.', on: { finish: { target: 'done', description: 'It is finished.' } } },
      done: { type: 'final', description: 'Finished.' },
    },
  })

  let explode = true
  const collector = backseat<{ got: unknown[] }, { type: 'collect' }>()
  const gathering = collector.createMachine({
    id: 'gathering',
    description: 'Spawns one worker and collects it.',
    actors: { settling },
    context: { got: [] },
    initial: 'out',
    states: {
      out: {
        description: 'A worker is out.',
        entry: collector.spawnChild('settling', { id: 'w', input: { item: 'x' } }),
        on: {
          collect: {
            target: 'gathered',
            description: 'The worker is back.',
            // First in the list, as the demo's file-writing action is: the riskiest action runs at the one moment
            // when the collection is the only copy of what came back.
            actions: collectChildren(
              'out',
              'settling',
              () => {
                if (explode) throw new Error('disk full')
              },
              assign({ got: ({ event }) => event.settled.flatMap((site) => site.children.map((child) => child.output)) }),
            ),
          },
        },
      },
      gathered: { description: 'Collected.', type: 'final' },
    },
  })

  it('leaves the actor where it was, with the children uncollected and the site still collectable', async () => {
    let n = 0
    explode = true
    const rt = createRuntime({ machines: { gathering }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('gathering')
    await rt.send('r1/w', { type: 'finish' })

    const failed = (await rt.send('r1', { type: 'collect' })) as Rejection
    expect(failed.rejected).toBe(true)
    // Not `refused`: nothing chose this. The message carries what threw, so a bug cannot hide as a guard.
    expect(failed.reason).toBe('action-failed')
    expect(failed.message).toContain('disk full')
    // The actor did not move and is not errored — the whole point. Before the fix this was `status: 'error'` and
    // every later call was refused with `actor-error`.
    expect(failed.status).toBe('active')
    expect(failed.state.map((s) => s.id)).toEqual(['out'])

    // And the collection is genuinely repeatable: the child was neither stopped nor left flagged collected, so the
    // same transition takes once the condition that threw has cleared. This is what orphaning cost before.
    explode = false
    const gathered = (await rt.send('r1', { type: 'collect' })) as Summary
    expect(gathered.state.map((s) => s.id)).toEqual(['gathered'])
    expect(gathered.data).toMatchObject({})
    // the child is gone from the parent now that the stop action actually ran
    expect(gathered.children).toEqual([])
  })
})

// XState files a spawned child under its id and replaces whatever that key held without stopping it. The child it
// replaced runs on, held by nothing: never pending, never collected, its output lost, and no error anywhere. A fixed
// id is fine on a state its children are always collected out of, and wrong on one re-entered while they still run,
// so lowering cannot tell the two apart. The call that collides is refused instead, and nothing it did is kept.
describe('a spawn under an id a child already holds', () => {
  const items = backseat<{ item: string }, { type: 'finish' }, { item: string }>()
  const task = items.createMachine({
    id: 'task',
    description: 'One item of work.',
    context: items.withCheckInput(({ input }) => ({ item: input.item }), { item: 'sample' }),
    output: ({ context }) => ({ item: context.item }),
    initial: 'working',
    states: {
      working: { description: 'Being worked.', on: { finish: { target: 'done', description: 'It is finished.' } } },
      done: { type: 'final', description: 'Finished.' },
    },
  })

  const types = backseat<{ n: number }, { type: 'again' } | { type: 'collect' }>()
  const fixed = types.createMachine({
    id: 'fixed',
    description: 'Spawns its worker under one fixed id every time it is entered.',
    actors: { task },
    context: { n: 0 },
    initial: 'out',
    states: {
      out: {
        description: 'A worker is out.',
        entry: types.spawnChild('task', { id: 'w', input: { item: 'x' } }),
        on: {
          again: { target: 'out', reenter: true, description: 'Go again without collecting.', actions: assign({ n: ({ context }) => context.n + 1 }) },
          collect: { target: 'out', reenter: true, description: 'Collect, then go again.', actions: collectChildren('out', 'task') },
        },
      },
    },
  })

  const runtimeOf = (machines: Parameters<typeof createRuntime>[0]['machines']) => {
    let n = 0
    return createRuntime({ machines, store: memoryStore(), createId: () => `r${++n}` })
  }

  it('refuses a re-entry that would replace a child still running, and leaves that child driven and collectable', async () => {
    const rt = runtimeOf({ fixed })
    await rt.create('fixed')
    const failed = (await rt.send('r1', { type: 'again' })) as Rejection
    expect(failed.reason).toBe('action-failed')
    expect(failed.message).toContain("'r1/w'")
    expect(failed.status).toBe('active')
    // The first worker is the one still filed: the agent driving it loses nothing, and the lead can still collect it.
    expect((await rt.snapshot('r1/w')).state.map((s) => s.id)).toEqual(['working'])
    await rt.send('r1/w', { type: 'finish' })
    expect(await rt.send('r1', { type: 'collect' })).not.toHaveProperty('rejected')
  })

  it('refuses one that would replace a child finished but not yet collected, whose output would be lost', async () => {
    const rt = runtimeOf({ fixed })
    await rt.create('fixed')
    await rt.send('r1/w', { type: 'finish' })
    expect(((await rt.send('r1', { type: 'again' })) as Rejection).reason).toBe('action-failed')
  })

  it('reuses the id once the child that held it is collected, since collecting stops it', async () => {
    const rt = runtimeOf({ fixed })
    await rt.create('fixed')
    await rt.send('r1/w', { type: 'finish' })
    const next = (await rt.send('r1', { type: 'collect' })) as Summary
    // Announced and filed as new, though its key is the old one's: told to the agent, and gating the next collection.
    expect(next.children).toEqual([{ id: 'r1/w', about: { item: 'x' } }])
    expect((await rt.snapshot('r1/w')).state.map((s) => s.id)).toEqual(['working'])
    expect(((await rt.send('r1', { type: 'collect' })) as Rejection).reason).toBe('pending-children')
  })

  it('refuses to create a machine whose first state spawns two children under one id', async () => {
    const doubled = types.createMachine({
      id: 'doubled',
      description: 'Spawns two workers under one id.',
      actors: { task },
      context: { n: 0 },
      initial: 'out',
      states: {
        out: {
          description: 'Two workers are out.',
          entry: [types.spawnChild('task', { id: 'w', input: { item: 'x' } }), types.spawnChild('task', { id: 'w', input: { item: 'y' } })],
          on: { collect: { target: 'out', reenter: true, description: 'Collect them.', actions: collectChildren('out', 'task') } },
        },
      },
    })
    await expect(runtimeOf({ doubled }).create('doubled')).rejects.toThrow("Two children were spawned as 'r1/w' and only the second was kept.")
  })
})

/**
 * A machine that owns its tools calls them through transitions, so the refusals it already has govern them. The
 * human's rulings these encode: the tool call is a transition; what it returns reaches the machine's actions and the
 * agent alike, through the event; and the agent sees it through `data`, once, on the response to the call that made it.
 */
describe('a transition runs the tool the machine needs, and its output reaches the agent only through the event', () => {
  const stock = () => {
    shelf.notes = new Map([['a', 'Alpha'], ['b', 'Beta']])
    shelf.writes = []
  }
  const start = async () => {
    stock()
    let n = 0
    const rt = createRuntime({ machines: { reader }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('reader')
    return rt
  }

  it('hands what the effect returned to the actions, which keep what must persist, and to data, which shows the rest', async () => {
    const rt = await start()
    const read = (await rt.send('r1', { type: 'note.read', id: 'a' })) as Summary
    // The action assigned from `event.output.id`; `data` read the note itself off the same event.
    expect(read.data).toEqual({ reads: 1, note: { id: 'a', text: 'Alpha' } })
    expect(read.state.map((s) => s.id)).toEqual(['reading'])
  })

  it('shows the output once: the next response carries what context kept, and not what the call returned', async () => {
    const rt = await start()
    await rt.send('r1', { type: 'note.read', id: 'a' })
    // Nothing was persisted to show it, so nothing can show it again: this is what keeps it from being hidden context.
    expect((await rt.snapshot('r1')).data).toEqual({ reads: 1 })
    // `describe` without an event is the other response that carries `data` (with one, it prints the move alone: ADR-0015).
    expect(((await rt.describe('r1')) as { data?: unknown }).data).toEqual({ reads: 1 })
  })

  it('never shows output on a rejection, and never runs the effect for one the checks already refused', async () => {
    const rt = await start()
    const writesBefore = shelf.writes.length
    const invalid = (await rt.send('r1', { type: 'note.write', id: '', text: 'x' })) as Rejection
    expect(invalid.reason).toBe('invalid-payload')
    expect(invalid.data).toEqual({ reads: 0 })
    expect(shelf.writes.length).toBe(writesBefore) // the write never happened: validation runs first
    const unknown = (await rt.send('r1', { type: 'note.erase', id: 'a' })) as Rejection
    expect(unknown.reason).toBe('unknown-event')
    expect(unknown.data).toEqual({ reads: 0 })
  })

  it('lets an effect refuse the event with what to do instead, and the actor does not move', async () => {
    const rt = await start()
    const traced = await rt.sendTraced('r1', { type: 'note.read', id: 'zzz' })
    const refused = traced.response as Rejection
    expect(refused.reason).toBe('refused')
    expect(refused.message).toBe("There is no note 'zzz'; the shelf holds a, b.")
    expect(refused.data).toEqual({ reads: 0 })
    // It threw rather than returned, so there is no output for the trace to record.
    expect(traced.effect).toBeUndefined()
    expect((await rt.snapshot('r1')).data).toEqual({ reads: 0 })
  })

  it('cannot be handed an output by the agent: the payload loses it, and the effect\'s is the one the actions see', async () => {
    const rt = await start()
    const read = (await rt.send('r1', { type: 'note.read', id: 'b', output: { id: 'forged', text: 'Forged' } })) as Summary
    expect(read.data).toEqual({ reads: 1, note: { id: 'b', text: 'Beta' } })
  })

  it('records the full output in the trace, which becomes the read log', async () => {
    const rt = await start()
    const traced = await rt.sendTraced('r1', { type: 'note.write', id: 'c', text: 'Gamma' })
    expect(traced.effect).toEqual({ output: { written: 'c' } })
    expect(shelf.writes).toEqual([{ id: 'c', text: 'Gamma' }])
    // A transition with no effect records none.
    expect((await rt.sendTraced('r1', { type: 'done' })).effect).toBeUndefined()
  })

  const bare = backseat<{ n: number }, { type: 'go'; output: number } | { type: 'stay' }>()
  const build = (effect: () => number, action: () => void = () => {}) =>
    bare.createMachine({
      id: 'bare',
      description: 'One effect.',
      context: { n: 0 },
      initial: 'here',
      states: {
        here: { description: 'Here.', on: { go: { target: 'there', description: 'Go.', effect, actions: [action, assign({ n: ({ event }) => event.output })] } } },
        there: { description: 'There.', type: 'final' },
      },
    })

  it('answers action-failed when an effect throws anything but a refusal, and leaves the actor where it was', async () => {
    const rt = createRuntime({ machines: { bare: build(() => { throw new Error('connection reset') }) }, store: memoryStore(), createId: () => 'r1' })
    await rt.create('bare')
    const failed = (await rt.send('r1', { type: 'go' })) as Rejection
    expect([failed.reason, failed.message, failed.status]).toEqual(['action-failed', 'connection reset', 'active'])
    expect(failed.state.map((s) => s.id)).toEqual(['here'])
  })

  it('keeps a write an effect made when an action then refuses, and says so in the trace: the effect ran, the transition was discarded', async () => {
    const machine = build(() => 7, () => { throw new RejectedEvent('not now') })
    const rt = createRuntime({ machines: { bare: machine }, store: memoryStore(), createId: () => 'r1' })
    await rt.create('bare')
    const traced = await rt.sendTraced('r1', { type: 'go' })
    expect((traced.response as Rejection).reason).toBe('refused')
    expect(traced.effect).toEqual({ output: 7 })
    expect((await rt.snapshot('r1')).state.map((s) => s.id)).toEqual(['here'])
  })

  it('refuses to send into an actor that another call moved while the effect was awaited, rather than land unchecked', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = backseat<{ n: number }, { type: 'go'; output: number } | { type: 'stay' }>().createMachine({
      id: 'slow',
      description: 'An effect that waits.',
      context: { n: 0 },
      initial: 'here',
      states: {
        here: {
          description: 'Here.',
          on: {
            go: { target: 'there', description: 'Go.', effect: async () => (await gate, 1) },
            stay: { description: 'Stay.', actions: assign({ n: ({ context }) => context.n + 1 }) },
          },
        },
        there: { description: 'There.', type: 'final' },
      },
    })
    const rt = createRuntime({ machines: { slow }, store: memoryStore(), createId: () => 'r1' })
    await rt.create('slow')
    const going = rt.send('r1', { type: 'go' })
    await rt.send('r1', { type: 'stay' }) // lands while the effect is still waiting
    release()
    await expect(going).rejects.toThrow("'r1' changed while the effect of 'go' ran; calls on one root must not overlap")
  })

  it('refuses at build time a schema that declares output, and an effect on a key no agent sends', () => {
    const typed = backseat<{ n: number }, { type: 'go'; output: string }>()
    expect(() =>
      typed.createMachine({
        id: 'forged',
        description: 'Declares output.',
        context: { n: 0 },
        initial: 'here',
        states: { here: { description: 'Here.', on: { go: { description: 'Go.', schema: z.object({ output: z.string() }), effect: () => 'x' } } } },
      }),
    ).toThrow("meta.schema on 'go' from 'forged.here' declares 'output', which is reserved")
    const plain = backseat<{ n: number }, { type: 'go' }>()
    expect(() =>
      plain.createMachine({
        id: 'unsent',
        description: 'An effect nobody sends.',
        context: { n: 0 },
        initial: 'here',
        // `always` refuses an effect in the types too; this is the check a machine in raw XState reaches.
        states: { here: { description: 'Here.', always: { effect: (() => 1) as never }, on: { go: { description: 'Go.' } } } },
      }),
    ).toThrow("an effect on 'always' from 'unsent.here' would run with no agent's call to run in")
  })

  // `onDone` reaches XState as written rather than through the lowering `on` and `always` get, so without this an
  // effect that got past the types would simply never run, and a schema would validate nothing, with no error at all.
  it('refuses on onDone a Backseat key that got past its type, rather than dropping it', () => {
    const plain = backseat<{ n: number }, { type: 'go' }>()
    const round = (onDone: unknown) =>
      plain.createMachine({
        id: 'round',
        description: 'A round left by its own completion.',
        context: { n: 0 },
        initial: 'open',
        states: {
          open: { description: 'Open.', initial: 'a', onDone: onDone as never, states: { a: { description: 'A.', type: 'final' } } },
          closed: { description: 'Closed.', type: 'final' },
        },
      })
    expect(() => round({ target: 'closed', effect: () => 1 })).toThrow("round: states.open.onDone: 'effect' means nothing on onDone, which no agent sends")
    expect(() => round([{ target: 'closed', schema: z.object({}) }])).toThrow("round: states.open.onDone[0]: 'schema' means nothing on onDone")
    expect(() => round({ target: 'closed', actions: collectChildren('open', 'worker') })).toThrow('collectChildren means nothing on onDone')
    expect(() => round({ target: 'closed', meta: { settled: [] } })).toThrow("round: states.open.onDone.meta: 'settled' under meta is Backseat's to write")
    expect(() => round({ target: 'closed', description: 'The round closed.' })).not.toThrow()
  })
})

/**
 * The deep-research worker's `finding.submit` checks each cited page at the source. The recorded Branson run accepted a
 * citation whose own title said "page 404'd" (`recorded/1/calls/054` as of 9c7c27a): the instructions asked for sources the agent
 * would stand behind, and nothing enforced it. The check refuses only what it is sure of, so a page that blocks bots or
 * cannot be reached still passes; it is an effect, not a guard, because a dead link is only knowable once the payload
 * names it. A page is gone only when a GET says so too: a later run refused a live events page whose server answers HEAD
 * with 404 and GET with the page.
 */
describe("the deep-research worker refuses a finding that cites a page that is gone", () => {
  const live = 'https://example.org/live'
  const gone = 'https://example.org/gone'
  const summary = 'A finding long enough to pass the schema, written from the hits and listing only the sources drawn on.'

  // A root takes no input and the worker needs one, so a lead of one move spawns it the way the deep-research lead does.
  const { createMachine, spawnChild } = backseat<{ subQuestion: string }, { type: 'go' } | { type: 'done' }>()
  const dispatch = createMachine({
    id: 'dispatch',
    description: 'Spawns one research worker.',
    actors: { worker: researchTask },
    context: { subQuestion: 'Where can children fish for free near Branson?' },
    initial: 'waiting',
    states: {
      waiting: {
        description: 'No worker yet.',
        instructions: 'Send go to spawn the worker.',
        on: { go: { target: 'working', description: 'Spawn the worker.' } },
      },
      working: {
        description: 'The worker is running.',
        instructions: 'Drive the worker, then send done.',
        entry: spawnChild('worker', {
          id: () => 'w',
          input: ({ context }) => ({ subQuestion: context.subQuestion, question: 'Where is the best place to take my kids fishing in Branson, MO?' }),
          about: ({ context }) => context.subQuestion,
        }),
        on: { done: { target: 'finished', description: 'The worker is back.', actions: collectChildren('working', 'worker', () => {}) } },
      },
      finished: { type: 'final', description: 'Finished.' },
    },
  })

  afterEach(() => vi.restoreAllMocks())

  /**
   * A worker at `summarizing`, with `fetch` answering each URL by status — one for every method, or one per method — and
   * throwing for one it cannot reach.
   */
  const summarizing = async (statuses: Record<string, number | Error | { HEAD: number; GET: number }>) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const answer = statuses[String(input)]
      if (answer instanceof Error) throw answer
      const status = typeof answer === 'object' ? answer[init?.method === 'HEAD' ? 'HEAD' : 'GET'] : answer
      return new Response(null, { status })
    })
    let n = 0
    const rt = createRuntime({ machines: { dispatch }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('dispatch')
    await rt.send('r1', { type: 'go' })
    await rt.send('r1/w', { type: 'queries.submit', queries: ['first query', 'second query'] })
    await rt.send('r1/w', { type: 'search.results', query: 'first query' })
    const arrived = (await rt.send('r1/w', { type: 'search.results', query: 'second query' })) as Summary
    expect(arrived.state.map((s) => s.id)).toEqual(['summarizing'])
    return rt
  }

  it('refuses with the gone page named and what to do instead, and the actor does not move', async () => {
    const rt = await summarizing({ [live]: 200, [gone]: 404 })
    const sources = [{ url: live, title: 'Live' }, { url: gone, title: 'Gone' }]
    const refused = (await rt.send('r1/w', { type: 'finding.submit', summary, sources })) as Rejection
    expect(refused.reason).toBe('refused')
    expect(refused.message).toBe(`${gone} is gone (HTTP 404). Cite the page you read instead, or drop it and say what rested on it.`)
    expect(refused.state.map((s) => s.id)).toEqual(['summarizing'])
    expect((await rt.snapshot('r1/w')).state.map((s) => s.id)).toEqual(['summarizing'])
  })

  it('accepts a finding whose sources resolve, and passes one it cannot be sure of: a 403, or a page it cannot reach', async () => {
    const blocked = 'https://example.org/blocked'
    const unreachable = 'https://example.org/unreachable'
    const rt = await summarizing({ [live]: 200, [blocked]: 403, [unreachable]: new TypeError('fetch failed') })
    const sources = [{ url: live, title: 'Live' }, { url: blocked, title: 'Blocked' }, { url: unreachable, title: 'Unreachable' }]
    const done = (await rt.send('r1/w', { type: 'finding.submit', summary, sources })) as Summary
    expect(done.state.map((s) => s.id)).toEqual(['complete'])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('accepts a page that answers HEAD with 404 but serves it to GET, since the page is not gone', async () => {
    const headless = 'https://example.org/headless'
    const rt = await summarizing({ [live]: 200, [headless]: { HEAD: 404, GET: 200 } })
    const sources = [{ url: live, title: 'Live' }, { url: headless, title: 'Headless' }]
    const done = (await rt.send('r1/w', { type: 'finding.submit', summary, sources })) as Summary
    expect(done.state.map((s) => s.id)).toEqual(['complete'])
  })
})
