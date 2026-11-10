import { assign } from 'xstate'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { lintMachine, RejectedEvent, styleRule } from '../runtime/index.js'
import type { Finding, RuleId } from '../runtime/index.js'
import { backseat } from './machine.js'
import { prReview } from '../../../../demos/pr-review/pr-review.js'
import { deepResearch } from '../../../../demos/deep-research/deep-research.js'
import registry from '../runtime/style-rules.json' with { type: 'json' }

/**
 * The five facts `lintMachine` can establish, each measured against the shape its rule is about.
 *
 * The bargain the lint is built on is that it is never wrong, so every check here has a **negative** beside its
 * positive: the shape that must stay silent matters more than the shape that must fire. Two of these negatives are
 * mistakes easy to make in a walk over a machine — a guard reads `context.checks` through `context.`, and
 * `deep-research`'s `citing.accepted` ends a region that `onDone` carries the agent straight past.
 */
const facts = (machine: unknown, rule?: RuleId): string[] =>
  lintMachine('fixture', machine as never)
    .findings.filter((f: Finding) => rule === undefined || f.rule === rule)
    .map((f: Finding) => `${f.where}: ${f.fact}`)

describe('spend-the-last-word — a final state spends the last thing the agent reads', () => {
  it('finds an ending that says nothing', () => {
    const m = backseat<{ n: number }, { type: 'go' }>().createMachine({
      id: 'm',
      description: 'A machine with one ending.',
      context: { n: 0 },
      output: ({ context }) => ({ n: context.n }),
      initial: 'start',
      states: {
        start: { description: 'The beginning.', instructions: 'Send go.', on: { go: { target: 'done', description: 'Finish.' } } },
        done: { type: 'final', description: 'Finished.' },
      },
    })
    expect(facts(m, 'spend-the-last-word')).toEqual(['done: is a final state with no instructions: arriving there closes the actor having said nothing'])
  })

  it('stays silent on a region ending, which onDone carries the agent straight past', () => {
    expect(facts(deepResearch, 'spend-the-last-word')).toEqual([])
  })

  it('finds two endings reaching for one form of words', () => {
    const m = backseat<{ n: number }, { type: 'ok' } | { type: 'no' }>().createMachine({
      id: 'm',
      description: 'A machine with two endings.',
      context: { n: 0 },
      output: ({ context }) => ({ n: context.n }),
      initial: 'start',
      states: {
        start: {
          description: 'The beginning.',
          instructions: 'Send ok or no.',
          on: { ok: { target: 'kept', description: 'It held.' }, no: { target: 'dropped', description: 'It did not.' } },
        },
        kept: { type: 'final', description: 'Kept.', instructions: 'Nothing is left to do.' },
        dropped: { type: 'final', description: 'Dropped.', instructions: 'Nothing is left to do.' },
      },
    })
    expect(facts(m, 'spend-the-last-word')).toContain('kept, dropped: are 2 final states whose instructions are the same string: "Nothing is left to do."')
  })
})

describe('bound-every-loop — a loop needs a door at the bound', () => {
  it('finds a cycle no transition leaves', () => {
    const m = backseat<{ n: number }, { type: 'there' } | { type: 'back' }>().createMachine({
      id: 'm',
      description: 'A machine that cannot end.',
      context: { n: 0 },
      initial: 'here',
      states: {
        here: { description: 'Here.', instructions: 'Send there.', on: { there: { target: 'yonder', description: 'Go.' } } },
        yonder: { description: 'Yonder.', instructions: 'Send back.', on: { back: { target: 'here', description: 'Return.' } } },
      },
    })
    expect(facts(m, 'bound-every-loop')).toEqual(['here, yonder: form a cycle no transition leaves: here -> yonder and back'])
  })

  it("stays silent on pr-review's bounded build-review round", () => {
    expect(facts(prReview, 'bound-every-loop')).toEqual([])
  })
})

describe('data-only-across-readers — `data` only where the reader is not the writer', () => {
  const author = (data: (args: { context: { pr: string; rounds: number } }) => unknown) =>
    backseat<{ pr: string; rounds: number }, { type: 'open'; pr: string } | { type: 'done' }>().createMachine({
      id: 'm',
      description: 'A machine that publishes something.',
      context: { pr: '', rounds: 0 },
      initial: 'opening',
      states: {
        opening: {
          description: 'Open it.',
          instructions: 'Send open with the pull request.',
          on: { open: { target: 'working', description: 'It opened.', schema: z.object({ pr: z.string() }), actions: assign({ pr: ({ event }) => event.pr }) } },
        },
        working: { description: 'Work it.', instructions: 'Send done.', data, on: { done: { target: 'over', description: 'Finish.' } } },
        over: { type: 'final', description: 'Over.', instructions: 'Say what you did.' },
      },
    })

  it('finds a key every path here has already sent', () => {
    expect(facts(author(({ context: { pr } }) => ({ pr })), 'data-only-across-readers')).toEqual([
      "working: publishes `data.pr`, and every path here has already taken 'open', whose schema carries `pr`",
    ])
  })

  it('stays silent on a value the machine itself computed', () => {
    expect(facts(author(({ context: { rounds } }) => ({ rounds })), 'data-only-across-readers')).toEqual([])
  })

  it('declines on a machine that spawns, where a child driver may not have the value', () => {
    expect(lintMachine('deep-research', deepResearch as never).declined.map((d) => d.rule)).toContain('data-only-across-readers')
  })
})

describe('store-nothing-unread — store nothing in context that nothing reads', () => {
  const author = (extra: Record<string, unknown>, output?: (c: never) => unknown) =>
    backseat<{ kept: string; checks: { passed: boolean }[] }, { type: 'go' }>().createMachine({
      id: 'm',
      description: 'A machine with a context.',
      context: { kept: '', checks: [], ...extra } as never,
      output: (output ?? (({ context }: never) => ({ kept: (context as { kept: string }).kept }))) as never,
      initial: 'start',
      states: {
        start: {
          description: 'The beginning.',
          instructions: 'Send go.',
          on: { go: [{ guard: everyCheckPassed, target: 'done', description: 'Finish.' }] },
        },
        done: { type: 'final', description: 'Done.', instructions: 'Say what happened.' },
      },
    })

  it('finds a field with no reader', () => {
    expect(facts(author({ museum: 'piece' }), 'store-nothing-unread')).toEqual([
      'context.museum: is named by no guard, context-derived schema, `data` projection, instruction block, `effect` or the root `output`',
    ])
  })

  it('stays silent on a field read only through `context.` inside a guard', () => {
    // `context.checks` is the canonical read, so an identifier match that refused a preceding dot would report the
    // one field the guard exists to read.
    expect(facts(author({}), 'store-nothing-unread')).toEqual([])
  })

  it('finds a field its own prose names, because prose is not a reader', () => {
    const m = backseat<{ plan: string[] }, { type: 'go' }>().createMachine({
      id: 'm',
      description: 'A machine whose prose uses its own field names as English.',
      context: { plan: [] },
      initial: 'start',
      states: {
        // A field named with an ordinary English word — `plan`, `gaps`, `intent` — is one prose uses, so matching raw
        // reader source would call it alive because a sentence says it.
        start: { description: 'The beginning.', instructions: 'Turn what is missing into a plan, then send go.', on: { go: { target: 'done', description: 'Finish.' } } },
        done: { type: 'final', description: 'Done.', instructions: 'Say what happened.' },
      },
    })
    expect(facts(m, 'store-nothing-unread')).toEqual([
      'context.plan: is named by no guard, context-derived schema, `data` projection, instruction block, `effect` or the root `output`',
    ])
  })

  it('declines where a reader calls a helper it cannot see into', () => {
    expect(lintMachine('deep-research', deepResearch as never).declined.map((d) => d.rule)).toContain('store-nothing-unread')
  })

  it('does not count an async arrow or a RejectedEvent as a helper it cannot see into', () => {
    // An async effect that refuses is the ordinary shape of one, and declining on it would leave the check silent on
    // every machine that refuses anything.
    const m = backseat<{ kept: string }, { type: 'go' }>().createMachine({
      id: 'm',
      description: 'A machine whose effect refuses.',
      context: { kept: '' },
      initial: 'start',
      states: {
        start: {
          description: 'The beginning.',
          instructions: 'Send go.',
          on: {
            go: {
              target: 'done',
              description: 'Finish.',
              effect: async ({ context }) => {
                if (!context.kept) throw new RejectedEvent('nothing kept')
              },
            },
          },
        },
        done: { type: 'final', description: 'Done.', instructions: 'Say what happened.' },
      },
    })
    expect(lintMachine('m', m as never).declined.map((d) => d.rule)).not.toContain('store-nothing-unread')
  })
})

/**
 * A finding explains itself: the registry gives every rule a check can report a title and a why, so a person reading
 * lint output needs no document open beside it. The ids are what other documents link to, so they are pinned here —
 * renaming one breaks every link to it.
 */
describe('the rule registry', () => {
  const ids: RuleId[] = ['data-only-across-readers', 'bound-every-loop', 'spend-the-last-word', 'store-nothing-unread']

  it('holds exactly the rules the checks report, once each', () => {
    expect(registry.map((rule) => rule.id).sort()).toEqual([...ids].sort())
  })

  it('gives each rule a title and a why that stand on their own, pointing at no file or issue', () => {
    for (const id of ids) {
      const { title, why } = styleRule(id)
      expect(title.length).toBeGreaterThan(0)
      expect(why.length).toBeGreaterThan(0)
      expect(why).not.toMatch(/\.md\b|#\d/)
    }
  })
})

/** The standing measurement: the two authored use-cases, after the cold read fixed them by hand, have nothing left to say. */
describe('the machines the rules came from', () => {
  it('pr-review is clean', () => {
    expect(lintMachine('pr-review', prReview as never).findings).toEqual([])
  })

  // The lead only. `backseat lint` recurses the roster and `research-task` is not clean — it accumulates
  // `context.processed` and nothing reads it. Naming the
  // scope here rather than in a name that would read as a clean demo.
  it("deep-research's lead is clean on every check that can speak about it", () => {
    expect(lintMachine('deep-research', deepResearch as never).findings).toEqual([])
  })
})

const everyCheckPassed = ({ context }: { context: { checks: { passed: boolean }[] } }) => context.checks.every((check) => check.passed)
