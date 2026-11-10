import type { AnyStateMachine, AnyTransitionDefinition } from 'xstate'
import { stripId } from './enumerate.js'

/**
 * What a call moved, exactly enough to read a journey against the code that ran it. The state an actor landed in
 * cannot tell two guarded transitions to one target apart, cannot show a state passed straight through, and cannot see
 * a transition that acts without moving at all.
 *
 * **The record carries facts, not pointers.** It is denormalised for one reason: `backseat-ai report` takes a directory and reads `trace.jsonl` and nothing else, so a
 * completed run stays readable long after the code that ran it changed, or moved, or went away.
 */

/** One transition an actor took. A step that lands nowhere (`to` absent) ran its actions and left the actor where it was. */
export type Step = {
  /** The state the transition is listed on, spelled as the Summary spells a state. */
  from: string
  /** The descriptor it is listed under; `always` for an eventless one. */
  event: string
  /** The guard's name, when it has one: what tells two transitions on one event apart. */
  guard?: string
  /** Where it went, when it went anywhere. */
  to?: string[]
}

/**
 * Names a function acquires from where it was written rather than from what it is. JavaScript names an anonymous
 * function after whatever it is being assigned to, and a guard is written at a property called `guard` — so
 * `guard: ({ context }) => …` produces a function literally named `"guard"`, on every guard in every machine. That is
 * worse than no name: it looks like one, and `Step.guard` exists to tell two transitions on one event apart.
 */
const UNINFORMATIVE = new Set(['', 'guard'])

/**
 * A guard's name. A machine is one TypeScript value, so an inline function is the only legal form and its `.name` is
 * the whole of what can be recorded — which the pin makes trustworthy, `fn.name` surviving a served module
 * byte-identical. A `guard: roundComplete` naming a const reads as it always did; an inline arrow is named after its
 * own property and records nothing, and the fix is to hoist it to a named const.
 */
const guardName = (guard: unknown): string | undefined => {
  if (typeof guard === 'string') return guard
  if (typeof guard === 'function') return UNINFORMATIVE.has(guard.name) ? undefined : guard.name
  if (typeof guard === 'object' && guard !== null && typeof (guard as { type?: unknown }).type === 'string') return (guard as { type: string }).type
  return undefined
}

/** The transitions one actor took during a call, as the record keeps them. */
export function stepsOf(transitions: AnyTransitionDefinition[], machine: AnyStateMachine): Step[] {
  return transitions.map((transition) => {
    const descriptor = transition.eventType ?? ''
    const step: Step = { from: stripId(machine, transition.source.id), event: descriptor === '' ? 'always' : descriptor }
    const guard = guardName(transition.guard)
    if (guard !== undefined) step.guard = guard
    if (transition.target?.length) step.to = transition.target.map((target) => stripId(machine, target.id))
    return step
  })
}
