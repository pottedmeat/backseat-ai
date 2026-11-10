import { assign } from 'xstate'
import { backseat } from 'backseat-ai'

/**
 * One transition written once and used in two states, through `transition()`.
 *
 * A fourth fixture, for the same reason the others are separate: its negatives pin what an author sees when a hoisted
 * transition goes wrong, and growing another fixture would move assertions that are about something else.
 */

type Ctx = { count: number }
type Ev = { type: 'bump'; by: number } | { type: 'rest' } | { type: 'finish' }

const { createMachine, transition } = backseat<Ctx, Ev>()

// Written for `bump`, so `event.by` is typed here. Its target is checked where it is used.
const bump = transition('bump')({
  target: 'counting',
  description: 'The count goes up.',
  actions: assign({ count: ({ context, event }) => context.count + event.by }),
})

export const counter = createMachine({
  id: 'counter',
  description: 'Counts up, with a rest between bumps whenever the agent wants one.',
  context: { count: 0 },
  initial: 'counting',
  states: {
    counting: {
      description: 'Counting.',
      instructions: 'Bump the count, rest, or finish.',
      on: { bump, rest: { target: 'resting', description: 'A rest.' }, finish: { target: 'done', description: 'The count is done.' } },
    },
    resting: {
      description: 'Resting.',
      instructions: 'Bump the count to start again.',
      on: { bump },
    },
    done: { type: 'final', description: 'Done counting.' },
  },
})
