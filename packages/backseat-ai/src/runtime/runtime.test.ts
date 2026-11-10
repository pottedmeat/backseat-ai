import { assign, fromPromise, setup, spawnChild } from 'xstate'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { agentTracking, checkInstructionData, createRuntime, dataNames, driveProtocol, memoryStore, renderSchema, validateMachine } from './index.js'
import type { AgentMeta, AgentTrackingContext, AgentTrackingEvent, Description, Rejection, Summary, Visit } from './index.js'

// A miniature of the deep-research shape: a lead that briefs, plans, spawns one worker per item off a queue,
// joins on done events, and decides under a budget whether to go again.

const worker = setup({
  types: {
    context: {} as { agent: AgentTrackingContext; q: string },
    input: {} as { q: string },
    events: {} as AgentTrackingEvent | { type: 'FINISH'; note: string },
    meta: {} as AgentMeta,
  },
}).createMachine({
  id: 'worker',
  description: 'One unit of work.',
  context: ({ input }) => ({ ...agentTracking.context, q: input.q }),
  output: ({ context }) => ({ q: context.q }),
  on: { ...agentTracking.on },
  initial: 'working',
  states: {
    working: {
      description: 'Work is pending.',
      meta: { data: ({ context: { q } }) => ({ q }), instructions: ({ visit }) => (visit === 'first' ? 'Do the work for q.' : 'Still working.') },
      on: { FINISH: 'done' },
    },
    done: { type: 'final', description: 'Finished.', meta: { schema: z.object({ note: z.string() }) } },
  },
})

type LeadContext = {
  agent: AgentTrackingContext
  round: number
  maxRounds: number
  pending: string[]
  current: string | null
  spawned: number
}

type LeadEvent =
  | AgentTrackingEvent
  | { type: 'brief.submit'; question: string; maxRounds: number }
  | { type: 'plan.submit'; items: string[] }
  | { type: 'item.next' }
  | { type: 'round.review' }
  | { type: 'skip'; amount?: number }
  | { type: 'round.again' }
  | { type: 'conclude' }
  | { type: 'finish' }

const planSchema = z.object({ question: z.string().min(3), maxRounds: z.number().int().min(1).max(5).default(2) })

const lead = setup({
  actors: { worker },
  types: { context: {} as LeadContext, events: {} as LeadEvent, meta: {} as AgentMeta },
  guards: {
    hasPending: ({ context }) => context.pending.length > 0,
    canRetry: ({ context }) => context.round < context.maxRounds,
  },
}).createMachine({
  id: 'lead',
  description: 'Test lead.',
  context: { ...agentTracking.context, round: 0, maxRounds: 2, pending: [], current: null, spawned: 0 },
  on: { ...agentTracking.on },
  initial: 'briefing',
  states: {
    briefing: {
      description: 'No brief yet.',
      meta: { data: ({ context: { round } }) => ({ round }), instructions: ({ visit }) => (visit === 'first' ? 'State the brief.' : 'Brief again.') },
      on: { 'brief.submit': { target: 'planning', description: 'Give the brief.', actions: assign({ maxRounds: ({ event }) => event.maxRounds }) } },
    },
    planning: {
      description: 'Needs a plan.',
      meta: { schema: planSchema, instructions: ({ visit }) => (visit === 'first' ? 'Plan.' : 'Plan the gaps.') },
      on: {
        'plan.submit': {
          target: 'working',
          actions: assign({ pending: ({ event }) => event.items, round: ({ context }) => context.round + 1, spawned: 0 }),
        },
      },
    },
    working: {
      description: 'Items are being worked.',
      meta: { data: ({ context: { current } }) => ({ current }), schema: z.object({ items: z.array(z.string()).min(1) }), instructions: 'Pull items.', sites: [{ src: 'worker' }] },
      on: {
        'item.next': {
          guard: 'hasPending',
          actions: assign({
            current: ({ context }) => context.pending[0] ?? null,
            pending: ({ context }) => context.pending.slice(1),
            spawned: ({ context, spawn }) => {
              spawn('worker', { id: `w-${context.spawned}`, input: { q: context.pending[0] ?? '' } })
              return context.spawned + 1
            },
          }),
        },
        // The lead is *told* when the round is over, never pushed. A worker finishing is not the lead's move, so it
        // cannot be the lead's transition (ADR-0008); the lead sends this and is refused while any worker is still
        // running, naming the ones it is waiting on.
        'round.review': { target: 'reviewing', description: 'Every worker is back.', meta: { settled: [{ state: 'working', src: 'worker' }] } },
        // Deliberately breaks the guard convention: passes with no payload, may fail with one.
        skip: {
          guard: ({ event }) => event.amount === undefined || event.amount > 10,
          target: 'reviewing',
          meta: { schema: z.object({ amount: z.number() }) },
        },
      },
    },
    reviewing: {
      description: 'Judge the round.',
      on: {
        'round.again': [
          { guard: 'canRetry', target: 'planning', description: 'Gaps remain.' },
          { target: 'closing', description: 'Budget spent.' },
        ],
        conclude: { target: 'closing', meta: { instructions: 'Say goodbye.' } },
      },
    },
    closing: {
      description: 'Wrapping up.',
      initial: 'awaiting',
      states: {
        awaiting: { description: 'Awaiting the sign-off.', on: { finish: 'signed' } },
        signed: { type: 'final', description: 'Signed off.' },
      },
      onDone: 'complete',
    },
    complete: { type: 'final', description: 'All done.' },
  },
})

function runtime(store = memoryStore()) {
  let n = 0
  return createRuntime({ machines: { lead }, store, createId: () => `r${++n}` })
}

const eventTypes = (s: Summary) => s.targets.flatMap((t) => t.events.map((e) => `${e.type}->${t.id}`))
const asRejection = (r: Summary | Description | Rejection): Rejection => {
  expect('rejected' in r && r.rejected).toBe(true)
  return r as Rejection
}

describe('discovery and progressive disclosure', () => {
  it('lists machines by root description so the agent can pick a machine', () => {
    expect(runtime().machines()).toEqual([{ name: 'lead', description: 'Test lead.' }])
  })

  it('shows the initial state with full instructions, schema, and data; a later response there shows the reminder and the move by name', async () => {
    const rt = runtime()
    const first = await rt.create('lead')
    expect(first.actorId).toBe('r1')
    expect(first.status).toBe('active')
    // No `description` on arrival, the first included: it says why an agent would go there, which is spent once it is
    // there, and the instructions carry the meaning.
    expect(first.state).toEqual([{ id: 'briefing', instructions: 'State the brief.' }])
    expect(first.data).toEqual({ round: 0 })
    expect(first.targets).toEqual([
      {
        id: 'planning',
        description: 'Needs a plan.',
        events: [{ type: 'brief.submit', description: 'Give the brief.', schema: renderSchema(planSchema) }],
      },
    ])
    expect(first.children).toEqual([])

    const again = await rt.snapshot('r1')
    expect(again.state[0]?.instructions).toBe('Brief again.')
    expect(again.targets[0]?.events[0]?.schema).toBeUndefined()
    // Flagged, so the print names the move and points at `describe` rather than say it all again (ADR-0016).
    expect(again.targets[0]?.events[0]?.listed).toBe(true)
  })

  it('lists a state\'s moves whole on the first response there, then by name, except a move that is new or changed', async () => {
    // Every response repeated the whole move list, ~4K tokens of headings and descriptions the first response in the
    // state had already given. The human approved, in their words: "Yes and make the move-list change" (ADR-0016). What
    // must not be lost: a move the driver has not seen whole here, or whose text changed, is still printed whole.
    const mover = setup({
      types: {
        context: {} as { agent: AgentTrackingContext; n: number },
        events: {} as AgentTrackingEvent | { type: 'bump' } | { type: 'peek'; at: number } | { type: 'open' } | { type: 'go' } | { type: 'back' },
        meta: {} as AgentMeta,
      },
    }).createMachine({
      id: 'mover',
      description: 'Mover.',
      context: { ...agentTracking.context, n: 0 },
      on: { ...agentTracking.on },
      initial: 'a',
      states: {
        a: {
          description: 'A.',
          on: {
            bump: { description: 'Count one.', actions: assign({ n: ({ context }) => context.n + 1 }) },
            peek: { description: 'Look.', meta: { schema: ({ n }) => z.object({ at: z.literal(n) }), effect: () => 'seen' } },
            open: { guard: ({ context }) => context.n > 0, target: 'b', description: 'Opened by a bump.' },
            go: { target: 'b', description: 'Leave.' },
          },
        },
        b: { description: 'B.', on: { back: { target: 'a', description: 'Return.' } } },
      },
    })
    const rt = createRuntime({ machines: { mover }, createId: () => 'm1' })
    const moves = (s: Summary) => Object.fromEntries(s.targets.flatMap((t) => t.events.map((e) => [`${e.type}->${t.id}`, e])))

    const first = await rt.create('mover')
    expect(Object.values(moves(first)).every((e) => !e.listed)).toBe(true)

    const again = moves(await rt.snapshot('m1'))
    expect(Object.keys(again)).toEqual(['bump->a', 'peek->a', 'go->b'])
    expect(Object.values(again).every((e) => e.listed && e.schema === undefined)).toBe(true)

    // A send that stays here: `open` is newly offered and `peek`'s schema changed with `n`, so both print whole.
    const bumped = moves((await rt.send('m1', { type: 'bump' })) as Summary)
    expect(bumped['open->b']?.listed).toBeUndefined()
    expect(bumped['peek->a']).toMatchObject({ description: 'Look.', schema: '{\n  at: 1\n}' })
    expect(bumped['peek->a']?.listed).toBeUndefined()
    expect(bumped['bump->a']?.listed).toBe(true)
    expect(bumped['go->b']?.listed).toBe(true)

    // A refusal lists by name too; its news still leads.
    const refused = asRejection(await rt.send('m1', { type: 'nope' }))
    expect(Object.values(moves(refused)).every((e) => e.listed)).toBe(true)

    // `describe` without an event is the state whole, for a driver that inherits the actor.
    const whole = (await rt.describe('m1')) as Summary
    expect(Object.values(moves(whole)).every((e) => !e.listed)).toBe(true)
    expect(moves(whole)['go->b']?.description).toBe('Leave.')

    // Another state's first response is whole; coming back to one already listed is by name, as its instructions are a revisit.
    const inB = moves((await rt.send('m1', { type: 'go' })) as Summary)
    expect(inB['back->a']?.listed).toBeUndefined()
    const back = moves((await rt.send('m1', { type: 'back' })) as Summary)
    expect(Object.values(back).every((e) => e.listed)).toBe(true)
  })

  it('shows a read move declared on the root once per actor, not again in every state it is listed under', async () => {
    // A targetless root move is listed under whichever state the actor is in. Keyed by that, its schema was re-sent,
    // unchanged, on the first arrival at every state: one arrival re-sent 58 such schemas, 13.5 KB (ADR-0016). A
    // changed schema must still show.
    const reader = setup({
      types: {
        context: {} as { agent: AgentTrackingContext; n: number },
        events: {} as AgentTrackingEvent | { type: 'index.search'; q: string; scope: string } | { type: 'next' },
        meta: {} as AgentMeta,
      },
    }).createMachine({
      id: 'reader',
      description: 'Reader.',
      context: { ...agentTracking.context, n: 0 },
      on: {
        ...agentTracking.on,
        'index.search': { meta: { schema: ({ n }) => z.object({ q: z.string(), scope: z.literal(n < 2 ? 'all' : 'mine') }), effect: () => 'hit' } },
      },
      initial: 'a',
      states: {
        a: { description: 'A.', on: { next: { target: 'b', actions: assign({ n: ({ context }) => context.n + 1 }) } } },
        b: { description: 'B.', on: { next: { target: 'c', actions: assign({ n: ({ context }) => context.n + 1 }) } } },
        c: { description: 'C.' },
      },
    })
    const rt = createRuntime({ machines: { reader }, createId: () => 'r1' })
    const search = (s: Summary) => s.targets.flatMap((t) => t.events).find((e) => e.type === 'index.search')!
    expect(search(await rt.create('reader')).schema).toBe('{\n  q: string\n  scope: "all"\n}')

    const inB = search(await rt.send('r1', { type: 'next' }))
    expect(inB.schema).toBeUndefined()
    expect(inB.schemaShown).toBe(true)

    const inC = search(await rt.send('r1', { type: 'next' }))
    expect(inC.schema).toBe('{\n  q: string\n  scope: "mine"\n}')
  })

  it('describe with an event returns that move alone, so the schema a driver asked for is not buried under the state', async () => {
    // Drivers sent empty payloads to learn a schema, because describe printed the state's full instructions and data
    // first and the schema last (ADR-0015).
    const rt = runtime()
    await rt.create('lead')
    const described = (await rt.describe('r1', 'brief.submit')) as Description
    expect(described).toEqual({
      actorId: 'r1',
      status: 'active',
      state: [{ id: 'briefing' }],
      event: { type: 'brief.submit', description: 'Give the brief.', target: { id: 'planning', description: 'Needs a plan.' }, schema: renderSchema(planSchema) },
    })
    const bad = asRejection(await rt.describe('r1', 'nope'))
    expect(bad.reason).toBe('unknown-event')
  })

  it('describe without an event hands back the full first instructions, for an agent that inherits the actor mid-flight', async () => {
    // `snapshot` gives a returning driver the revisit text; a new driver taking over needs the first-arrival account,
    // and describe with an event no longer carries it, so this is where it lives.
    const rt = runtime()
    await rt.create('lead')
    expect((await rt.snapshot('r1')).state[0]?.instructions).toBe('Brief again.')
    const full = (await rt.describe('r1')) as Summary
    expect(full.state[0]?.instructions).toBe('State the brief.')
    expect(full.data).toEqual({ round: 0 })
    expect(full.targets.map((t) => t.id)).toEqual(['planning'])
  })
})

describe('send', () => {
  it('moves on a valid payload, applying schema defaults and dropping unknown keys before the machine sees the event', async () => {
    const rt = runtime()
    await rt.create('lead')
    const moved = await rt.send('r1', { type: 'brief.submit', question: 'why?', stray: 1 })
    expect(moved.state).toEqual([{ id: 'planning', instructions: 'Plan.' }])
    expect(eventTypes(moved)).toEqual(['plan.submit->working'])
    // The default maxRounds of 2 reached the assign: a second round is still offered later.
    await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    await rt.send('r1', { type: 'skip', amount: 20 })
    const review = await rt.snapshot('r1')
    expect(eventTypes(review)).toEqual(['round.again->planning', 'conclude->closing'])
  })

  it('rejects an invalid payload with issues and the merged schema, leaving the actor where it was', async () => {
    const rt = runtime()
    await rt.create('lead')
    const rejected = asRejection(await rt.send('r1', { type: 'brief.submit', question: 'x' }))
    expect(rejected.reason).toBe('invalid-payload')
    expect(rejected.issues).toEqual([{ path: 'question', message: expect.stringContaining('>=3') }])
    expect(rejected.schema).toBe(renderSchema(planSchema))
    expect(rejected.state[0]?.id).toBe('briefing')
  })

  it('rejects unknown events before they reach the actor at all', async () => {
    const rt = runtime()
    await rt.create('lead')
    const rejected = asRejection(await rt.send('r1', { type: 'nope' }))
    expect(rejected.reason).toBe('unknown-event')
    // The catch-all this used to be observed through is now refused outright, so what is left to assert is that
    // the actor is untouched: same state, same projection, nothing spent.
    expect(rejected.data).toEqual({ round: 0 })
  })

  it('never lists a guarded-off event on any response, and refuses it as not offered from the state it is in', async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?' })
    await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    await rt.send('r1', { type: 'item.next' })
    // `item.next` is still defined on `working`, but `hasPending` now hides it: the queue is empty.
    const hidden = asRejection(await rt.send('r1', { type: 'item.next' }))
    expect(hidden.reason).toBe('not-enabled')
    expect(hidden.state[0]?.id).toBe('working')
    // A move not offered now is shown nowhere (ADR-0008): not on the refusal, a snapshot or the bare describe. A driver
    // that sees an event listed may send it; one it would be refused for must not be there to see.
    const offers = (summary: Summary) => summary.targets.flatMap((t) => t.events.map((e) => e.type))
    expect(offers(hidden)).not.toContain('item.next')
    expect(offers(await rt.snapshot('r1'))).not.toContain('item.next')
    expect(offers((await rt.describe('r1')) as Summary)).not.toContain('item.next')
    // `describe` draws the same line.
    expect(asRejection(await rt.describe('r1', 'item.next')).reason).toBe('not-enabled')
    expect(asRejection(await rt.describe('r1', 'nope')).reason).toBe('unknown-event')
  })

  it('reports transition-not-taken when a payload-dependent guard fails after validation, without sending', async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?' })
    await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    const rejected = asRejection(await rt.send('r1', { type: 'skip', amount: 5 }))
    expect(rejected.reason).toBe('transition-not-taken')
    expect(rejected.state[0]?.id).toBe('working')
  })

  it('refuses to drive a finished actor', async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?' })
    await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    await rt.send('r1', { type: 'skip', amount: 20 })
    await rt.send('r1', { type: 'conclude' })
    const done = await rt.send('r1', { type: 'finish' })
    expect(done.status).toBe('done')
    expect(done.state).toEqual([{ id: 'complete' }])
    expect(done.targets).toEqual([])
    expect('output' in done).toBe(false)
    expect(asRejection(await rt.send('r1', { type: 'finish' })).reason).toBe('actor-done')
  })
})

describe('enumeration', () => {
  it('lists a guarded event under the alternative that would fire, so a spent budget visibly removes the option', async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?', maxRounds: 1 })
    await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    const review = await rt.send('r1', { type: 'skip', amount: 20 })
    expect(review.targets.map((t) => [t.id, t.events.map((e) => e.description)])).toEqual([
      ['closing', [['Budget spent.'], [undefined]].flat()],
    ])
    const closed = await rt.send('r1', { type: 'round.again' })
    expect(closed.state[0]?.id).toBe('closing.awaiting')
  })

  it('lists a targetless transition under the current state and hides it once its guard closes, or while its children run', async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?' })
    const working = await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    expect(eventTypes(working)).toEqual(['item.next->working', 'round.review->reviewing', 'skip->reviewing'])
    expect(working.data).toEqual({ current: null })
    const pulled = await rt.send('r1', { type: 'item.next' })
    expect(pulled.data).toEqual({ current: 'a' })
    // `item.next` goes, its guard having closed; `round.review` goes too while the worker `item.next` spawned is still
    // out, since sending it would be refused as `pending-children`: a move not offered now is not shown (ADR-0008).
    expect(eventTypes(pulled)).toEqual(['skip->reviewing'])
    // And the response says a move is held back for the worker, so an empty list can say why rather than "Nothing".
    expect(pulled.awaiting).toBe(true)
    expect(working.awaiting).toBeUndefined()
  })

  it('names a compound target by the node the author targeted and reports the atomic state actually entered', async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?' })
    await rt.send('r1', { type: 'plan.submit', items: ['a'] })
    await rt.send('r1', { type: 'skip', amount: 20 })
    const closing = await rt.send('r1', { type: 'conclude' })
    expect(closing.transition).toEqual({ type: 'conclude', instructions: 'Say goodbye.' })
    expect(closing.state).toEqual([{ id: 'closing.awaiting' }])
    expect(closing.targets).toEqual([{ id: 'closing.signed', description: 'Signed off.', events: [{ type: 'finish', schema: '{}' }] }])
  })

  it('fails loud when a guard reads the payload it cannot have during enumeration', async () => {
    const broken = setup({ types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent | { type: 'GO'; x: { y: number } } } }).createMachine({
      id: 'broken',
      description: 'Broken.',
      context: { ...agentTracking.context },
      on: { ...agentTracking.on },
      initial: 'a',
      states: { a: { on: { GO: { guard: ({ event }) => (event as { x: { y: number } }).x.y > 1, target: 'b' } } }, b: { description: 'B.' } },
    })
    const rt = createRuntime({ machines: { broken } })
    await expect(rt.create('broken')).rejects.toThrow(/Guard for 'GO' threw.*must not read the event payload/)
  })
})

describe('children and parents', () => {
  it("returns spawned children with what they are for, lets a subagent drive one by id, and a child finishing does not spend the parent's first look", async () => {
    const rt = runtime()
    await rt.create('lead')
    await rt.send('r1', { type: 'brief.submit', question: 'why?' })
    await rt.send('r1', { type: 'plan.submit', items: ['a', 'b'] })

    // This lead spawns from inside an `assign`, declaring no `about`, so each child is announced with the input it was
    // actually resolved with — the zero-config half of `about`, and it works for a plain XState spawn the same way.
    const first = await rt.send('r1', { type: 'item.next' })
    expect(first.children).toEqual([{ id: 'r1/w-0', about: { q: 'a' } }])
    const second = await rt.send('r1', { type: 'item.next' })
    expect(second.children).toEqual([{ id: 'r1/w-1', about: { q: 'b' } }])
    // Said once, on the call that spawned. A later look carries nothing about the children still running: the parent
    // holds their ids and asks them, which is the whole of what replaces repeating it.
    expect((await rt.snapshot('r1')).children).toBeUndefined()

    const child = await rt.snapshot('r1/w-0')
    expect(child.state).toEqual([{ id: 'working', instructions: 'Do the work for q.' }])
    expect(child.targets[0]?.events[0]?.schema).toBe('{\n  note: string\n}')

    // A worker finishing is the worker's move and nobody else's. The lead is not on this list and cannot be: an `on`
    // key for a child's done event is refused outright, so the one call, one actor rule holds by construction
    // rather than by every machine remembering to behave.
    const doneFirst = await rt.sendTraced('r1/w-0', { type: 'FINISH', note: 'ok' })
    expect(doneFirst.response.status).toBe('done')
    expect(doneFirst.response).not.toHaveProperty('parent')
    expect(doneFirst.moved).toEqual([{ actorId: 'r1/w-0', state: ['done'], steps: [{ from: 'working', event: 'FINISH', to: ['done'] }] }])

    // The lead is still in working, and asking to leave while a worker is out is refused by name.
    const early = asRejection(await rt.send('r1', { type: 'round.review' }))
    expect(early.reason).toBe('pending-children')
    expect(early.state[0]?.id).toBe('working')

    const doneLast = await rt.sendTraced('r1/w-1', { type: 'FINISH', note: 'ok' })
    expect(doneLast.response).not.toHaveProperty('parent')
    expect(doneLast.moved).toEqual([{ actorId: 'r1/w-1', state: ['done'], steps: [{ from: 'working', event: 'FINISH', to: ['done'] }] }])
    expect(await rt.send('r1/w-1', { type: 'FINISH', note: 'ok' })).toMatchObject({ rejected: true })

    // A call spends the disclosure of the actor it names, and nothing else's: the lead's own send is what moves
    // it, and its first look at reviewing is still a first look, with the schema of the new pair.
    const reviewing = await rt.send('r1', { type: 'round.review' })
    expect(reviewing.state[0]?.id).toBe('reviewing')
    expect(eventTypes(reviewing)).toEqual(['round.again->planning', 'conclude->closing'])
    expect(reviewing.targets[0]?.events[0]?.schema).toEqual(expect.any(String))
    expect(asRejection(await rt.send('r1/w-1', { type: 'FINISH', note: 'again' })).reason).toBe('actor-done')
  })
})

describe('persistence', () => {
  it('rehydrates a root and its spawned children from the store with tracking intact', async () => {
    const store = memoryStore()
    const a = runtime(store)
    await a.create('lead')
    await a.send('r1', { type: 'brief.submit', question: 'why?' })
    await a.send('r1', { type: 'plan.submit', items: ['a'] })
    await a.send('r1', { type: 'item.next' })

    const b = runtime(store)
    const restored = await b.snapshot('r1')
    expect(restored.state).toEqual([{ id: 'working', instructions: 'Pull items.' }])
    expect(restored.targets[0]?.events[0]?.schema).toBeUndefined()

    const child = await b.send('r1/w-0', { type: 'FINISH', note: 'ok' })
    expect(child.status).toBe('done')
    // The child settling leaves the lead exactly where the first process left it; the lead's own send is what moves it.
    expect((await b.snapshot('r1')).state[0]?.id).toBe('working')
    expect((await b.send('r1', { type: 'round.review' })).state[0]?.id).toBe('reviewing')
    await expect(b.snapshot('nope')).rejects.toThrow("Unknown actor 'nope'")
  })
})

describe('context-derived schemas', () => {
  // A relay that names the item it answers: the schema is a function of context, so a stale report cannot land on the next item.
  const relay = setup({
    types: {
      context: {} as { agent: AgentTrackingContext; queue: string[]; current: string },
      events: {} as AgentTrackingEvent | { type: 'item.answer'; item: string; answer: string },
      meta: {} as AgentMeta<{ agent: AgentTrackingContext; queue: string[]; current: string }>,
    },
  }).createMachine({
    id: 'relay',
    description: 'Answer items one at a time.',
    context: { ...agentTracking.context, queue: ['b', 'c'], current: 'a' },
    on: { ...agentTracking.on },
    initial: 'answering',
    states: {
      answering: {
        description: 'An item is outstanding.',
        meta: { data: ({ context: { current } }) => ({ current }) },
        on: {
          'item.answer': {
            meta: { schema: ({ current }) => z.object({ item: z.literal(current), answer: z.string() }) },
            actions: assign({ current: ({ context }) => context.queue[0] ?? '', queue: ({ context }) => context.queue.slice(1) }),
          },
        },
      },
    },
  })

  it('renders, describes, and validates the schema against the current context, naming the received value on a stale report', async () => {
    const rt = createRuntime({ machines: { relay }, createId: () => 'r1' })
    const created = await rt.create('relay')
    expect(created.targets[0]!.events[0]!.schema).toBe('{\n  item: "a"\n  answer: string\n}')

    const moved = await rt.send('r1', { type: 'item.answer', item: 'a', answer: 'one' })
    expect(moved.data).toEqual({ current: 'b' })
    // The same call, replayed: the schema now names the next item, so the duplicate is refused and nothing advances.
    const stale = asRejection(await rt.send('r1', { type: 'item.answer', item: 'a', answer: 'one' }))
    expect(stale.reason).toBe('invalid-payload')
    expect(stale.issues).toEqual([{ path: 'item', message: 'Invalid input: expected "b", received "a"' }])
    expect(stale.schema).toBe('{\n  item: "b"\n  answer: string\n}')
    expect(stale.data).toEqual({ current: 'b' })

    const described = (await rt.describe('r1', 'item.answer')) as Description
    expect(described.event.schema).toBe('{\n  item: "b"\n  answer: string\n}')
  })

  it('re-shows the schema when its rendered text changes and keeps hiding it while it does not', async () => {
    // The offer tracks the value: a schema shown once for "a" is stale the moment context names "b", so the agent
    // must see it again; a call that leaves context alone must not repeat it.
    const rt = createRuntime({ machines: { relay }, createId: () => 'r1' })
    await rt.create('relay')
    const moved = await rt.send('r1', { type: 'item.answer', item: 'a', answer: 'one' })
    expect(moved.targets[0]!.events[0]!.schema).toBe('{\n  item: "b"\n  answer: string\n}')
    expect((await rt.snapshot('r1')).targets[0]!.events[0]!.schema).toBeUndefined()
    const again = await rt.send('r1', { type: 'item.answer', item: 'b', answer: 'two' })
    expect(again.targets[0]!.events[0]!.schema).toBe('{\n  item: "c"\n  answer: string\n}')
    expect((await rt.snapshot('r1')).targets[0]!.events[0]!.schema).toBeUndefined()
  })

  it('fails loud when the function returns something other than a zod object schema', async () => {
    const broken = setup({ types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent | { type: 'GO' }, meta: {} as AgentMeta } }).createMachine({
      id: 'broken',
      description: 'Broken.',
      context: { ...agentTracking.context },
      on: { ...agentTracking.on },
      initial: 'a',
      states: { a: { description: 'A.', on: { GO: { meta: { schema: () => z.string() as never }, actions: () => {} } } } },
    })
    const rt = createRuntime({ machines: { broken }, createId: () => 'r1' })
    await expect(rt.create('broken')).rejects.toThrow(/meta.schema on 'GO' from 'broken.a' must return a zod object schema/)
  })
})

describe('registration', () => {
  const base = { context: { ...agentTracking.context }, on: { ...agentTracking.on } }
  const check = (config: any) => () =>
    validateMachine('m', setup({ types: { meta: {} as AgentMeta } }).createMachine({ id: 'm', description: 'M.', ...base, ...config }))

  it('rejects a machine the agent could not be shown correctly', () => {
    expect(() => validateMachine('m', setup({}).createMachine({ id: 'm', ...base, initial: 'a', states: { a: {} } }))).toThrow(/root node needs a description/)
    expect(() => validateMachine('m', setup({}).createMachine({ id: 'm', description: 'M.', initial: 'a', states: { a: {} } }))).toThrow(/tracking hook/)
    expect(() => validateMachine('m', setup({}).createMachine({ id: 'm', description: 'M.', on: { ...agentTracking.on }, initial: 'a', states: { a: {} } }))).toThrow(/tracking slice/)
    expect(check({ initial: 'a', states: { a: { on: { GO: 'b' } }, b: {} } })).toThrow(/'m.b' is reached by 'GO' and needs a description/)
    expect(check({ initial: 'a', states: { a: { on: { GO: { target: 'b', meta: { schema: z.string() } } } }, b: { description: 'B.' } } })).toThrow(/must be a zod object schema/)
    expect(check({ initial: 'a', states: { a: { meta: { schema: z.object({}) } } } })).toThrow(/can never be presented/)
    expect(check({ type: 'parallel', states: { p: { initial: 'x', states: { x: { description: 'X.', on: { GO: { target: ['#m.p.y', '#m.q.y'] } } }, y: { description: 'Y.' } } }, q: { initial: 'x', states: { x: { description: 'X.' }, y: { description: 'Y.' } } } } })).toThrow(/several targets/)
  })

  /**
   * The backstop for ADR-0008's one remaining hole. The
   * typed surface refuses all four spellings as the author types them and is the real guarantee; this catches the
   * machine written in raw XState, as every fixture in this file is, that never passed through it.
   */
  it('rejects an on key no agent can send, whichever of the four ways it is spelled', () => {
    const refused = /is not an event an agent can send/
    expect(check({ initial: 'a', states: { a: { description: 'A.', on: { 'xstate.done.actor.*': { target: 'b' } } }, b: { description: 'B.' } } })).toThrow(refused)
    expect(check({ initial: 'a', states: { a: { description: 'A.', on: { 'xstate.error.actor.*': {} } } } })).toThrow(refused)
    expect(check({ initial: 'a', states: { a: { description: 'A.', on: { 'agent.sneak': {} } } } })).toThrow(refused)
    expect(check({ initial: 'a', states: { a: { description: 'A.', on: { '*': {} } } } })).toThrow(refused)
    expect(check({ initial: 'a', states: { a: { description: 'A.', on: { 'go.*': {} } } } })).toThrow(refused)
    // An `after` delay and an `invoke`'s completion are the same law from the same ADR, refused at the surface
    // and reaching the same check here, because both move the actor with no call naming it.
    expect(check({ initial: 'a', states: { a: { description: 'A.', after: { 1000: { target: 'b' } } }, b: { description: 'B.' } } })).toThrow(refused)
  })

  it('keeps the two descriptors the runtime reserves for itself', () => {
    // `onDone` resolves inside the agent's own settle, so it is the one `xstate.` key that is not a move behind an
    // agent's back; and the root carries the tracking hook and the child-failure absorber because the runtime put
    // them there. The absorber is exempt only in the shape the runtime writes — targetless and actionless.
    expect(check({ initial: 'g', states: { g: { description: 'G.', initial: 'x', onDone: { target: 'rest' }, states: { x: { description: 'X.', on: { GO: 'y' } }, y: { type: 'final', description: 'Y.' } } }, rest: { description: 'Rest.' } } })).not.toThrow()
    expect(check({ initial: 'a', states: { a: { description: 'A.' } } })).not.toThrow()
    const hijacked = { context: { ...agentTracking.context }, on: { ...agentTracking.on, 'xstate.error.actor.*': { actions: () => {} } } }
    expect(() => validateMachine('m', setup({ types: { meta: {} as AgentMeta } }).createMachine({ id: 'm', description: 'M.', ...hijacked, initial: 'a', states: { a: { description: 'A.' } } }))).toThrow(/is not an event an agent can send/)
  })

  it('rejects data on two states that can be active together, since Summary.data is one value', () => {
    const data = () => 1
    expect(check({ initial: 'a', states: { a: { meta: { data }, initial: 'x', states: { x: { meta: { data } } } } } })).toThrow(/meta.data on 'm.a' and 'm.a.x' can be active together/)
    expect(check({ type: 'parallel', states: { p: { initial: 'x', states: { x: { meta: { data } } } }, q: { initial: 'x', states: { x: { meta: { data } } } } } })).toThrow(/meta.data on 'm.p.x' and 'm.q.x' can be active together/)
    expect(check({ initial: 'a', states: { a: { meta: { data } }, b: { meta: { data } } } })).not.toThrow()
  })

  // Registration protects the agent-facing surface, and appearing in `options.machines` is how the runtime was
  // configured, not a safety property: a spawn-only machine is driven through the identical tool surface. `researchTask`
  // held three of the seven `data` projections and had never been through one of these checks. The miniature
  // `worker` above is itself spawn-only, so every other test in this file now registers it too.
  it('reaches a spawn-only machine through setup({ actors }), naming it by the path it was found on', () => {
    const child = setup({ types: { meta: {} as AgentMeta } }).createMachine({
      id: 'w',
      description: 'W.',
      ...base,
      initial: 'a',
      states: { a: { description: 'A.', meta: { instructions: 'Read `data.gone`.' } } },
    })
    const parent = setup({ actors: { child }, types: { meta: {} as AgentMeta } }).createMachine({
      id: 'l',
      description: 'L.',
      ...base,
      initial: 'a',
      states: { a: { description: 'A.' } },
    })
    expect(() => createRuntime({ machines: { parent } })).toThrow(/Machine 'parent > child': .*name 'data.gone'/)
  })

  it('walks past actor logic that is no machine, and terminates on a machine that spawns itself', () => {
    const selfSpawning: any = setup({ actors: { fetchIt: fromPromise(async () => 1) }, types: { meta: {} as AgentMeta } }).createMachine({
      id: 's',
      description: 'S.',
      ...base,
      initial: 'a',
      states: { a: { description: 'A.' } },
    })
    // A machine that spawns itself is a cycle in the walk; without the identity guard this never returns.
    selfSpawning.implementations.actors.again = selfSpawning
    expect(() => createRuntime({ machines: { selfSpawning } })).not.toThrow()
  })

  it('reports the real cause when the initial snapshot cannot be built, and takes a sample input from the root meta', () => {
    const needsInput = (meta?: AgentMeta) =>
      setup({ types: { input: {} as { dir: string }, meta: {} as AgentMeta } }).createMachine({
        id: 'm',
        description: 'M.',
        on: { ...agentTracking.on },
        ...(meta ? { meta } : {}),
        context: ({ input }) => ({ ...agentTracking.context, dir: input.dir.toUpperCase() }),
        initial: 'a',
        states: { a: { description: 'A.' } },
      })
    // XState absorbs a throwing initializer into an error snapshot rather than rethrowing. Left unread, the empty
    // context that follows failed the tracking-slice check and blamed the one thing that was present.
    expect(() => validateMachine('m', needsInput())).toThrow(/could not compute the initial snapshot: Cannot read properties of undefined/)
    expect(() => validateMachine('m', needsInput({ sampleInput: { dir: 'x' } }))).not.toThrow()
  })
})

describe('instruction data names', () => {
  const build = (config: any) =>
    setup({ types: { meta: {} as AgentMeta } }).createMachine({
      id: 'm',
      description: 'M.',
      context: { ...agentTracking.context },
      on: { ...agentTracking.on },
      ...config,
    })
  const check = (config: any) => () => checkInstructionData('m', build(config), {})
  const data = (...keys: string[]) => () => Object.fromEntries(keys.map((k) => [k, null]))

  it('resolves the marked form only, so a backticked event field is not read as a key', () => {
    // `sourceUrl` is a field of the citation payload, not a projection key: a bare identifier is not evidence.
    expect(dataNames('pairs a `claim` with a `sourceUrl` drawn from the sources in `data.findings`')).toEqual(['findings'])
    expect(dataNames('out of the `draft` in `data`')).toEqual([])
  })

  it('passes when the projection emits every key the prose names, on the state or an ancestor', () => {
    expect(check({ initial: 'a', states: { a: { meta: { data: data('findings'), instructions: 'Read `data.findings`.' } } } })).not.toThrow()
    expect(
      check({
        initial: 'a',
        states: { a: { meta: { data: data('current') }, initial: 'x', states: { x: { meta: { instructions: 'Run `data.current`.' } } } } },
      }),
    ).not.toThrow()
  })

  it('fails when the projection stopped emitting a key the prose still names', () => {
    expect(check({ initial: 'a', states: { a: { meta: { data: data('question'), instructions: 'Read `data.findings`.' } } } })).toThrow(
      /instructions on 'm.a' name 'data.findings', which meta.data on 'm.a' does not emit/,
    )
  })

  it('holds the revisit text to the same rule as the first', () => {
    expect(
      check({ initial: 'a', states: { a: { meta: { data: data('current'), instructions: ({ visit }: { visit: Visit }) => (visit === 'first' ? 'Read it.' : 'Run `data.gone`.') } } } }),
    ).toThrow(/name 'data.gone'/)
  })

  it('fails when no state active where the prose is read declares data at all', () => {
    expect(check({ initial: 'a', states: { a: { meta: { instructions: 'Read `data.findings`.' } } } })).toThrow(
      /name 'data.findings', but no state active there declares meta.data/,
    )
  })

  it('asks the key of every projection that could be live there, since which one is not statically known', () => {
    // Registration allows two declarers that cannot be active together; the parent's prose is read with either.
    expect(
      check({
        initial: 'a',
        states: {
          a: {
            meta: { instructions: 'Read `data.findings`.' },
            initial: 'x',
            states: { x: { meta: { data: data('findings') } }, y: { meta: { data: data('question') } } },
          },
        },
      }),
    ).toThrow(/instructions on 'm.a' name 'data.findings', which meta.data on 'm.a.y' does not emit/)
  })

  it("declines on a key an effect's output supplies, which registration has no event to produce, and on no other", () => {
    // `data.note` is emitted only on the response to a read, so the projection run without an event lacks it by design.
    const note = ({ event }: { event?: { output?: unknown } }) => (event?.output === undefined ? {} : { note: event.output })
    const reading = (effect: unknown) => ({
      initial: 'a',
      states: { a: { meta: { data: note, instructions: 'Read `data.note`.' }, on: { read: { actions: () => {}, ...(effect ? { meta: { effect } } : {}) } } } },
    })
    expect(check(reading(() => 'text'))).not.toThrow()
    // With no effect able to land there, the key is simply missing, as it always was.
    expect(check(reading(undefined))).toThrow(/name 'data.note', which meta.data on 'm.a' does not emit/)
  })

  it('attributes a projection that throws on the context registration has', () => {
    // Registration runs this check now, so a projection reaching for a value the registration context has not
    // got throws out of `createRuntime`. Unattributed it is the same unread failure, one layer out.
    const throwing = () => ({ n: (undefined as unknown as { x: number }).x })
    expect(
      check({ initial: 'a', states: { a: { meta: { data: throwing, instructions: 'Read `data.n`.' } } } }),
    ).toThrow(/meta.data on 'm.a' threw on the registration context/)
  })
})

describe('schema rendering', () => {
  it('prints TypeScript type text with constraints the agent must satisfy', () => {
    expect(renderSchema(planSchema)).toBe('{\n  question: string // min length 3\n  maxRounds?: number // integer, 1..5, default 2\n}')
    const citations = z.object({
      citations: z.array(z.object({ claim: z.string().min(10), sourceUrl: z.url() })).min(1),
      queries: z.array(z.string().min(3)).min(2).max(5),
      mode: z.enum(['fast', 'slow']).optional(),
      note: z.string().nullable(),
    })
    expect(renderSchema(citations)).toBe(
      [
        '{',
        '  citations: {',
        '    claim: string // min length 10',
        '    sourceUrl: string // uri',
        '  }[] // min 1 items',
        '  queries: string[] // min 2 items, max 5 items, each: min length 3',
        '  mode?: "fast" | "slow"',
        '  note: string | null',
        '}',
      ].join('\n'),
    )
  })

  it("carries a field's own `.describe()`, so why a field is wanted is said on the field and not in the prose above it", () => {
    // zod emits `description` through `toJSONSchema`. A renderer that drops it leaves instruction prose as the only
    // place to say what a field is for, and prose that does restates the schema (the style rule "do not say what the
    // schema says").
    const pr = z.object({
      url: z.url().describe('the pull request to review'),
      changedFiles: z.number().int().min(1).describe('how many files the diff touches'),
      note: z.string().optional(),
    })
    expect(renderSchema(pr)).toBe(
      [
        '{',
        '  url: string // the pull request to review (uri)',
        '  changedFiles: number // how many files the diff touches (integer, 1..9007199254740991)',
        '  note?: string',
        '}',
      ].join('\n'),
    )
  })

  it('leaves a described field with no constraints uncluttered by empty parentheses', () => {
    expect(renderSchema(z.object({ why: z.string().describe('why it could not be opened') }))).toBe('{\n  why: string // why it could not be opened\n}')
  })
})

describe('protocol instructions', () => {
  it('delivers no drive protocol when no bin is named, because the paragraph names the command it teaches', async () => {
    // The runtime is usable without a CLI in front of it; the protocol is not, since every rule in it is a rule about
    // invoking one. Silence is the honest answer rather than a paragraph about a command that does not exist.
    const rt = createRuntime({ machines: { lead } })
    expect((await rt.create('lead')).protocol).toBeUndefined()

    const named = createRuntime({ machines: { lead }, bin: 'test' })
    expect((await named.create('lead')).protocol).toEqual(driveProtocol('test'))
  })

  it("reaches the agent with the author's instructions exactly as authored, expanding nothing and adding nothing", async () => {
    // The runtime writes nothing about how an agent spawns subagents, and there is no longer any token for it to
    // expand: `{{protocol.handoff}}` and `expand()` are both gone, and nothing replaced them
    // (reversing the earlier runtime-placed handoff). An author
    // writes every word their driver reads on that, so the old token is now just characters in a string — which is
    // what this asserts, because a runtime that quietly rewrote prose is the failure being ruled out.
    const spawning = setup({ types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent, meta: {} as AgentMeta } }).createMachine({
      id: 'spawning',
      description: 'Spawns.',
      context: { ...agentTracking.context },
      on: { ...agentTracking.on },
      initial: 'fanning',
      states: { fanning: { description: 'Fanning out.', meta: { instructions: 'Dispatch each one. {{protocol.handoff}} Then wait.' } } },
    })
    const authored = 'Dispatch each one. {{protocol.handoff}} Then wait.'
    const named = await createRuntime({ machines: { spawning }, bin: 'test' }).create('spawning')
    expect(named.state[0]?.instructions).toBe(authored)
    const anonymous = await createRuntime({ machines: { spawning } }).create('spawning')
    expect(anonymous.state[0]?.instructions).toBe(authored)
  })

  it('places nothing of its own on arrival at a state that spawns, however the response is read', async () => {
    // The mirror of the test above, on the machine the old decision would have singled out: `lead` spawns, so it is
    // exactly where a runtime-placed handoff would have landed. Its arrival carries the author's instructions, the
    // drive protocol, and nothing else — no third paragraph, and no sibling field carrying one.
    const named = createRuntime({ machines: { lead }, bin: 'test', store: memoryStore(), createId: () => 'r1' })
    const created = await named.create('lead')
    expect(Object.keys(created).sort()).toEqual(['actorId', 'children', 'data', 'protocol', 'state', 'status', 'targets'])
    for (const node of created.state) expect(node.instructions ?? '').not.toContain('spawn one subagent')
  })
})

// `Filed.saw` was declared and documented from the start and written nowhere. It is gone, and this is why: the only
// child whose `src` is not a string is one spawned from an inline logic value, and XState will not persist that — so
// the call that would have recorded what the child "actually was" cannot complete. A roster name is not a convenience,
// it is the only thing a child can be filed under.
describe('a child spawned from an inline logic value', () => {
  const stray = setup({
    types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent, meta: {} as AgentMeta },
  }).createMachine({
    id: 'stray',
    description: 'Spawned by value, so nothing declares its site.',
    context: { ...agentTracking.context },
    on: { ...agentTracking.on },
    initial: 'idle',
    states: { idle: { description: 'Idle.' } },
  })

  const host = setup({
    types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent | { type: 'go' }, meta: {} as AgentMeta },
    // A host that registers no actors types an inline spawn's id as `undefined`; the id is what this test needs.
    actions: { sprout: spawnChild(stray, { id: 'kid' as never }) },
  }).createMachine({
    id: 'host',
    description: 'Spawns an undeclared child.',
    context: { ...agentTracking.context },
    on: { ...agentTracking.on },
    initial: 'a',
    states: {
      a: { description: 'A.', on: { go: { target: 'b', description: 'Sprout one.', actions: 'sprout' } } },
      b: { description: 'B.' },
    },
  })

  it('cannot be persisted, so no record can ever say what an undeclared child was', async () => {
    let n = 0
    const rt = createRuntime({ machines: { host }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('host')
    await expect(rt.send('r1', { type: 'go' })).rejects.toThrow(/inline child actor cannot be persisted/i)
  })
})

// JavaScript names an anonymous function after whatever it is assigned to, and a guard is written at a property
// called `guard` — so every inline guard in every machine arrived at the record named "guard". That is worse than no
// name, because `Step.guard` exists to tell two transitions on one event apart, and a constant tells them apart from
// nothing. Four steps of a real run recorded `"guard":"guard"` before this.
describe('the name a guard reaches the record under', () => {
  const contested = setup({
    types: { context: {} as { agent: AgentTrackingContext; left: number }, events: {} as AgentTrackingEvent | { type: 'go' }, meta: {} as AgentMeta },
  }).createMachine({
    id: 'contested',
    description: 'One event, two branches, told apart only by their guards.',
    context: { ...agentTracking.context, left: 1 },
    on: { ...agentTracking.on },
    initial: 'working',
    states: {
      working: {
        description: 'Working.',
        on: {
          go: [
            // Written the way an author reaches for first. Its `.name` is "guard", not "more".
            { guard: ({ context }) => context.left > 0, target: 'working', reenter: true, description: 'Another one.', actions: assign({ left: ({ context }) => context.left - 1 }) },
            { guard: none, target: 'done', description: 'No more.' },
          ],
        },
      },
      done: { description: 'Done.' },
    },
  })

  it('drops a name the language supplied, and keeps one the author chose', async () => {
    let n = 0
    const rt = createRuntime({ machines: { contested }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('contested')

    // The inline arrow: no name at all rather than a false one.
    const first = await rt.sendTraced('r1', { type: 'go' })
    expect(first.moved[0]?.steps).toEqual([{ from: 'working', event: 'go', to: ['working'] }])

    // The hoisted const: its own name, which is what makes the two branches distinguishable in the record.
    const second = await rt.sendTraced('r1', { type: 'go' })
    expect(second.moved[0]?.steps).toEqual([{ from: 'working', event: 'go', guard: 'none', to: ['done'] }])
  })
})

/** Hoisted so it has a name of its own; the point of the test above. */
function none({ context }: { context: { left: number } }) {
  return context.left <= 0
}

// When two regions of a parallel state both leave it on one event, XState keeps only the first, but the list the trace
// reads from still holds both. A journey read against the code would show the actor going somewhere it never went.
describe('the steps a parallel conflict leaves behind', () => {
  const split = setup({
    types: { context: {} as { agent: AgentTrackingContext }, events: {} as AgentTrackingEvent | { type: 'go' }, meta: {} as AgentMeta },
  }).createMachine({
    id: 'split',
    description: 'Two regions, each with its own way out on one event.',
    context: { ...agentTracking.context },
    on: { ...agentTracking.on },
    initial: 'both',
    states: {
      both: {
        type: 'parallel',
        states: {
          a: { initial: 'waiting', states: { waiting: { description: 'A waits.', on: { go: { target: '#split.outA', description: 'Out through A.' } } } } },
          b: { initial: 'waiting', states: { waiting: { description: 'B waits.', on: { go: { target: '#split.outB', description: 'Out through B.' } } } } },
        },
      },
      outA: { description: 'Out through A.' },
      outB: { description: 'Out through B.' },
    },
  })

  it('records only the region that left', async () => {
    let n = 0
    const rt = createRuntime({ machines: { split }, store: memoryStore(), createId: () => `r${++n}` })
    await rt.create('split')
    const moved = await rt.sendTraced('r1', { type: 'go' })
    expect(moved.moved).toEqual([{ actorId: 'r1', state: ['outA'], steps: [{ from: 'both.a.waiting', event: 'go', to: ['outA'] }] }])
  })
})
