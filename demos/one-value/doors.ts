import { assign } from 'xstate'
import { z } from 'zod'
import { backseat } from 'backseat-ai'

/**
 * The places a `target` can be written, the one place it cannot, and the two keys that are refused outright.
 *
 * A second fixture rather than more of `one-value.ts`: that one is also driven through `createRuntime`, and its
 * negatives pin the sibling union it prints, so growing it would move two assertions that are about something else.
 * The doors here are authoring-only. `after` and `invoke` cannot appear in a machine that compiles at all, so they
 * reach their negatives by replacement, which is why there is no sign of them below.
 */

type Ctx = { rounds: number }
type Ev = { type: 'start' } | { type: 'again' } | { type: 'finish'; note: string } | { type: 'reset' }

export const doors = backseat<Ctx, Ev>().createMachine({
  id: 'doors',
  description: 'Rounds, each one a grouped region left by its own completion.',
  context: { rounds: 0 },
  initial: 'idle',
  // The root's own `on` is offered from every state. It may act, but it names no target: the root has no siblings.
  on: { reset: { description: 'The count starts over, wherever the round is.', actions: assign({ rounds: 0 }) } },
  states: {
    idle: {
      description: 'No round has started.',
      instructions: 'Open the first round.',
      on: { start: { target: 'rounding', description: 'A round opens.' } },
    },

    // The live shape: a compound state whose region finishes at `settled`, left by `onDone` rather than by any
    // transition an agent sends. `onDone` is written here, on the compound state, so its target is this state's own
    // siblings — `resting` is one, and nothing inside `rounding` could have named it.
    rounding: {
      description: 'A round is open.',
      // XState's transition-object `initial`, whose target names a child: the fifth place a target is written.
      initial: { target: 'open' },
      onDone: { target: 'resting', description: 'The round closed.', actions: assign({ rounds: ({ context }) => context.rounds + 1 }) },
      states: {
        open: {
          description: 'The round is open.',
          instructions: 'Close this round with a note on what closed it.',
          on: {
            finish: {
              target: 'settled',
              description: 'The round closes.',
              // A schema belongs on a transition an agent is offered. The `onDone` below is the case that refuses one.
              schema: z.object({ note: z.string().describe('What closed the round.') }),
            },
          },
        },
        // A history state's default is the fourth place a target is written, and names a sibling like all the others.
        resumed: { type: 'history', target: 'open', description: 'Wherever the round had got to.' },
        settled: { type: 'final', description: 'The round is closed.' },
      },
    },

    resting: {
      description: 'Between rounds.',
      instructions: '`data.rounds` rounds are done. Open another, or start the count over.',
      data: ({ context: { rounds } }) => ({ rounds }),
      on: { again: { target: 'rounding', description: 'Another round opens.' } },
    },
  },
})
