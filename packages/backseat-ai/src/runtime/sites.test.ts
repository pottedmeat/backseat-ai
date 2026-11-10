import { describe, expect, it } from 'vitest'
import { requiresSentence } from './sites.js'

describe('the requires sentence', () => {
  it('is fixed wording, one clause per site, so an agent reads the same annotation on every machine', () => {
    expect(requiresSentence([{ state: 'researching', src: 'researchTask' }])).toBe('every child spawned at researching (researchTask) settled')
    expect(requiresSentence([{ state: 'a', src: 'x' }, { state: 'b', src: 'y' }])).toBe('every child spawned at a (x) settled, every child spawned at b (y) settled')
  })
})

describe('registration', () => {
  it('refuses a machine where one transition can reach two sites of one src, so a child is never filed by guesswork', async () => {
    const { setup } = await import('xstate')
    const { agentTracking, validateMachine } = await import('./index.js')
    const child = setup({}).createMachine({ id: 'c', description: 'C.' })
    const twice = setup({ actors: { c: child } }).createMachine({
      id: 'twice',
      description: 'Twice.',
      context: { ...agentTracking.context },
      on: { ...agentTracking.on },
      initial: 'a',
      states: {
        a: { description: 'A.', meta: { sites: [{ src: 'c' }] }, on: { GO: 'b' } },
        b: { description: 'B.', meta: { sites: [{ src: 'c' }] } },
      },
    })
    expect(() => validateMachine('twice', twice)).toThrow(/'GO' from 'a' can reach two spawn sites of 'c' \('a' and 'b'\)/)
  })
})
