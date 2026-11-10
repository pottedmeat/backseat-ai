import { assign } from 'xstate'
import { z } from 'zod'
import { backseat, RejectedEvent } from 'backseat-ai'

/**
 * A workflow that owns the tool it guards: every read and every write of the shelf is a transition, so the refusals
 * the runtime already has apply to it — a read in the wrong state is `not-enabled`, a read with no id is
 * `invalid-payload`, and the trace is the read log.
 *
 * A third fixture beside `one-value.ts` and `doors.ts`, for the same reason `doors.ts` is one: its negatives pin what
 * an effect's author sees, and growing either of the others would move assertions that are about something else. The
 * shelf is exported so a test can stock it and read back what was written.
 */
export const shelf = { notes: new Map<string, string>(), writes: [] as Array<{ id: string; text: string }> }

type Note = { id: string; text: string }
type Ctx = { reads: string[] }
// `output` on an event type is what its effect returns: the actions and `data` see it typed, the guard and the effect
// itself see the event as the agent sent it.
type Ev =
  | { type: 'note.read'; id: string; output: Note }
  | { type: 'note.write'; id: string; text: string; output: { written: string } }
  | { type: 'done' }

export const reader = backseat<Ctx, Ev>().createMachine({
  id: 'reader',
  description: 'Reads notes off a shelf, leaves one behind, and says when it is done.',
  context: { reads: [] },
  initial: 'reading',
  states: {
    reading: {
      description: 'Reading the shelf.',
      instructions:
        'Read notes by id; each comes back as `data.note`, on that response only. Leave a note of your own if you have one, and stop once you have read enough.',
      data: ({ context, event }) => ({
        reads: context.reads.length,
        ...(event?.type === 'note.read' && { note: event.output }),
      }),
      on: {
        'note.read': {
          description: 'Read one note by its id.',
          schema: z.object({ id: z.string().min(1) }),
          effect: ({ event }) => {
            const text = shelf.notes.get(event.id)
            if (text === undefined) throw new RejectedEvent(`There is no note '${event.id}'; the shelf holds ${[...shelf.notes.keys()].join(', ')}.`)
            return { id: event.id, text }
          },
          // The machine keeps which notes were read, never what they said: the agent was shown that once.
          actions: assign({ reads: ({ context, event }) => [...context.reads, event.output.id] }),
        },
        'note.write': {
          description: 'Leave a note on the shelf.',
          schema: z.object({ id: z.string().min(1), text: z.string().min(1) }),
          effect: async ({ event }) => {
            shelf.writes.push({ id: event.id, text: event.text })
            shelf.notes.set(event.id, event.text)
            return { written: event.id }
          },
        },
        done: { target: 'finished', description: 'Nothing more to read.' },
      },
    },
    finished: { type: 'final', description: 'Finished reading.' },
  },
})
