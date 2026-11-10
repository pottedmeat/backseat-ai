import { assign } from 'xstate'
import { z } from 'zod'
import { backseat, collectChildren } from 'backseat-ai'

// ---- the worker: spawned, never created, two states ---------------------------------------------------------------

type WorkerContext = { item: string; note: string | null }
type WorkerEvent = { type: 'finish'; note: string }

const { createMachine: createWorker, withCheckInput } = backseat<WorkerContext, WorkerEvent, { item: string }>()

export const worker = createWorker({
  id: 'worker',
  description: 'One item of work.',
  context: withCheckInput(({ input }) => ({ item: input.item, note: null }), { item: 'sample' }),
  output: ({ context }) => ({ item: context.item, note: context.note }),
  initial: 'working',
  states: {
    working: {
      description: 'The item is being worked.',
      instructions: ({ visit }) =>
        visit === 'first'
          ? 'Work on `data.item`, then finish it with a note on what you found.'
          : 'Still on `data.item`.',
      data: ({ context: { item } }) => ({ item }),
      on: {
        finish: {
          target: 'done',
          schema: z.object({ note: z.string().min(1) }),
          actions: assign({ note: ({ event }) => event.note }),
        },
      },
    },
    done: {
      type: 'final', description: 'The item is finished.',
      instructions:
        'Your note goes back to the lead with this actor\'s output: nothing to relay by hand, and nothing further ' +
        'to send here. Stop driving this actor and return — your finishing is the only signal the lead gets that ' +
        'this item is done.',
    },
  },
})

// ---- the lead: dispatches a worker per item, gates review on all of them settling ---------------------------------

type LeadContext = { items: string[]; current: string | null; reports: unknown[] }
type LeadEvent = { type: 'brief.submit'; items: string[] } | { type: 'item.next' } | { type: 'review.submit'; verdict: 'ok' | 'redo'; count: number }

const pullNext = ({ context }: { context: LeadContext }) => ({ current: context.items[0] ?? null, items: context.items.slice(1) })

// Hoisted for its name, not for reuse: an arrow written straight into `guard:` is named after that property, so it
// reaches the run record as "guard" and cannot say which branch of the contest was taken.
const itemsLeft = ({ context }: { context: LeadContext }) => context.items.length > 0

const { createMachine, spawnChild: spawnWorker } = backseat<LeadContext, LeadEvent>()

export const lead = createMachine({
  id: 'lead',
  description: 'Dispatches one worker per item, then reviews what came back.',
  actors: { worker },
  context: { items: [], current: null, reports: [] },
  initial: 'briefing',
  states: {
    briefing: {
      description: 'Waiting for the list of items.',
      instructions: 'Hand over the list of items to work.',
      on: {
        'brief.submit': {
          target: 'dispatching',
          schema: z.object({ items: z.array(z.string()).min(1) }),
          actions: assign(({ event }) => pullNext({ context: { items: event.items, current: null, reports: [] } })),
        },
      },
    },
    dispatching: {
      description: 'A worker is out on the current item.',
      // Told which arrival this is, so the reminder can differ from the briefing and both can read context.
      instructions: ({ context, visit }) =>
        visit === 'first'
          ? 'A worker holds `data.current`. Spawn a subagent and give it the listed command, so the worker\'s ' +
            'work stays out of your context and the workers run side by side. Move on to the next item, or to ' +
            'the review once none are left: the review waits until every worker is back.'
          : context.items.length
            ? '`data.remaining` still to dispatch.'
            : 'Nothing left to dispatch; move on to the review.',
      data: ({ context: { current, items } }) => ({ current, remaining: items.length }),
      // Backseat's spawnChild: XState's action, with the types XState cannot infer at a bare call site. `input` is the
      // child's; `about` is the lead's own note on this one worker, and says a thing the worker is never told.
      entry: spawnWorker('worker', {
        id: ({ context }) => `w-${context.current}`,
        input: ({ context }) => ({ item: context.current ?? '' }),
        about: ({ context }) => `item "${context.current}", ${context.items.length} still queued`,
      }),
      on: {
        'item.next': [
          { guard: itemsLeft, target: 'dispatching', reenter: true, description: 'Another item is waiting.', actions: assign(pullNext) },
          {
            target: 'reviewing',
            description: 'Nothing left to dispatch.',
            actions: collectChildren('dispatching', 'worker', assign({ reports: ({ event }) => event.settled.flatMap((site) => site.children.map((child) => child.output)) })),
          },
        ],
      },
    },
    reviewing: {
      description: 'Every worker is back.',
      instructions: 'Read `data.reports`, then give your verdict on them and the count you reviewed.',
      data: ({ context: { reports } }) => ({ reports }),
      on: {
        'review.submit': {
          target: 'done',
          description: 'The review is in.',
          // Derived from context: the count the agent sends must be the count it was shown.
          schema: ({ reports }) => z.object({ verdict: z.enum(['ok', 'redo']), count: z.literal(reports.length) }),
        },
      },
    },
    done: {
      type: 'final', description: 'Reviewed.',
      instructions:
        'Report the verdict and the count you reviewed to whoever asked for this run, in your own words: this ' +
        'actor is closed and its record is the only copy left. If the verdict was redo, say so plainly and name ' +
        'the items you would send back — the run ends here either way, and nothing will work them again.',
    },
  },
})
