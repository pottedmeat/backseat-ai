import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InspectionEvent } from 'xstate'
import { backseat } from '../compiler/index.js'
import { memoryStore } from './registry.js'
import { createRuntime } from './runtime.js'

// The peer range is `^5.32.6`, so a user can install an XState this release never ran on. This stands in for one that
// has dropped the private field the trace reads.
let dropField = false
vi.mock('xstate', async (original) => {
  const xstate = await original<typeof import('xstate')>()
  const createActor = (logic: never, options?: { inspect?: (event: InspectionEvent) => void }) => {
    const inspect = options?.inspect
    return xstate.createActor(logic, {
      ...options,
      inspect:
        inspect &&
        ((event: InspectionEvent) => {
          if (dropField && event.type === '@xstate.microstep') delete (event as { _transitions?: unknown })._transitions
          inspect(event)
        }),
    } as never)
  }
  return { ...xstate, createActor }
})

const machine = backseat<{ n: number }, { type: 'go' }>().createMachine({
  id: 'm',
  description: 'Moves once.',
  context: { n: 0 },
  initial: 'here',
  states: {
    here: { description: 'Here.', instructions: 'Go.', on: { go: { target: 'there' } } },
    there: { description: 'There.', instructions: 'Stay.', on: { go: { target: 'here' } } },
  },
})

describe('an XState without the field the trace reads', () => {
  beforeEach(() => {
    dropField = false
  })

  it('says what to do about it, because an installed XState is the one thing the range cannot rule out', async () => {
    const store = memoryStore()
    const runtime = createRuntime({ machines: { m: machine }, store, createId: () => 'r1' })
    await runtime.create('m')
    dropField = true
    await expect(runtime.send('r1', { type: 'go' })).rejects.toThrow(/_transitions.*XState.*5\.33\.3/s)
  })

  it('leaves the run where it was, so moving to a working XState picks it back up', async () => {
    const store = memoryStore()
    const runtime = createRuntime({ machines: { m: machine }, store, createId: () => 'r1' })
    await runtime.create('m')
    dropField = true
    await runtime.send('r1', { type: 'go' }).catch(() => undefined)
    dropField = false
    const after = createRuntime({ machines: { m: machine }, store, createId: () => 'r1' })
    expect(await after.send('r1', { type: 'go' })).toMatchObject({ status: 'active', state: [{ id: 'there' }] })
  })
})
