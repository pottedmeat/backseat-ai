import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { assign } from 'xstate'
import { z } from 'zod'
import { backseat } from '../compiler/index.js'
import { RejectedEvent } from '../runtime/index.js'
import { lead } from '../../../../demos/one-value/one-value.js'
import { dataTypes, toStately } from './stately.js'
import type { StatelyFile } from './stately.js'

// The export is for a person looking at a diagram in Stately Studio (ADR-0010). Each test pins something that person
// would otherwise be misled by: what the agent is told, and what refuses it, reaching the diagram; Backseat's own
// machinery staying out of it; and the machine they asked for being the one Studio imports.

const ONE_VALUE = fileURLToPath(new URL('../../../../demos/one-value/one-value.ts', import.meta.url))

describe('the stately export', () => {
  let files: StatelyFile[]
  let file: string // every file's code, for what holds wherever it lands
  beforeAll(async () => {
    files = toStately('one-value', lead, await dataTypes(ONE_VALUE))
    file = files.map((f) => f.code).join('\n')
  }, 30_000)

  it('writes each machine to its own file, so each pastes into Studio on its own', () => {
    expect(files.map((f) => f.name)).toEqual(['one-value.stately.ts', 'one-value.worker.stately.ts'])
    for (const f of files) expect(f.code.match(/^export const machine = setup/gm)).toHaveLength(1)
    // the parent's roster names the file the spawned machine is in: the one to paste to see it
    expect(files[0]!.code).toMatch(/actors: \{\n\s+"worker": "\.\/one-value\.worker\.stately\.ts",/)
  })

  it('puts what the agent is told in the description, both visits of it, since a diagram has no visit to resolve', () => {
    expect(file).toContain('**First visit:** Work on `data.item`, then finish it with a note on what you found.')
    expect(file).toContain('**Revisit:** Still on `data.item`.')
  })

  it('shows what `data` hands the agent as its type, not the function that computes it', () => {
    expect(file).toContain('"data": "{\\n  current: string | null\\n  remaining: number\\n}"')
    expect(file).not.toMatch(/"data": "\(\{/)
  })

  it('leaves out the machinery the compiler adds, which no author wrote and no agent sends', () => {
    expect(file).not.toContain('"agent"') // the tracking slice of context
    expect(file).not.toContain('agent.presented')
    expect(file).not.toContain('xstate.error.actor.*')
    expect(file).not.toContain('noteSpawn') // the note behind a spawn with `about`
    expect(file).not.toContain('stopChild') // stopCollected, closing every collecting transition
  })

  it('draws a spawn as a transition to where its children are collected, since Studio draws no spawned actor', () => {
    // `item.next`, once no item is left, collects the workers and goes to `reviewing`: the spawn is drawn there
    expect(file).toMatch(/"spawn:worker": \{\n\s+"target": "reviewing",\n\s+"description": "On entry, an agent is spawned that runs `worker`.",\n\s+"meta": \{\n\s+"@statelyai.color": "purple"/)
    expect(file).toContain('"spawns:worker"')
    expect(file).not.toContain('spawnChild')
  })

  it('names a hoisted guard by its const, so the diagram says which branch of a contest is which', () => {
    expect(file).toContain('"guard": "itemsLeft"')
    expect(file).toMatch(/guards: \{\n\s+"itemsLeft": /)
  })

  it('carries `reenter`, without which a self-transition that restarts the state reads as one that does not', () => {
    expect(file).toMatch(/"target": "dispatching",\n\s+"reenter": true/)
  })

  it('tags a refusal the diagram cannot otherwise show: a payload check beyond its types, and an action that refuses', () => {
    const { createMachine } = backseat<{ n: number }, { type: 'go'; n: number }>()
    const strict = createMachine({
      id: 'strict',
      description: 'Refuses in the two ways a diagram cannot draw.',
      context: { n: 0 },
      initial: 'waiting',
      states: {
        waiting: {
          description: 'Waiting for an even number.',
          instructions: 'Send go with an even number.',
          on: {
            go: {
              target: 'done',
              description: 'The number is in.',
              schema: z.object({ n: z.number() }).refine((payload) => payload.n % 2 === 0, 'must be even'),
              actions: assign({
                n: ({ event }) => {
                  if (event.n > 100) throw new RejectedEvent('too large')
                  return event.n
                },
              }),
            },
          },
        },
        done: { type: 'final', description: 'Finished.', instructions: 'Nothing is left to do.' },
      },
    })
    const tags = toStately('strict', strict)[0]!.code.match(/"tags": \[([^\]]*)\]/)?.[1]
    expect(tags).toContain('"refines:go"')
    expect(tags).toContain('"may-refuse:go"')
  })

  it('tags a transition that calls a tool, and an effect that refuses, since Studio draws neither', () => {
    const { createMachine } = backseat<{ n: number }, { type: 'look'; id: string; output: string }>()
    const looking = createMachine({
      id: 'looking',
      description: 'Looks things up.',
      context: { n: 0 },
      initial: 'reading',
      states: {
        reading: {
          description: 'Reading.',
          on: {
            look: {
              description: 'Look one up.',
              effect: ({ event }) => {
                if (event.id === '') throw new RejectedEvent('no id')
                return event.id
              },
            },
          },
        },
      },
    })
    const tags = toStately('looking', looking)[0]!.code.match(/"tags": \[([^\]]*)\]/)?.[1]
    // Without the tag, a read whose output only `data` shows is drawn as a transition that does nothing.
    expect(tags).toContain('"effect:look"')
    expect(tags).toContain('"may-refuse:look"')
  })
})
