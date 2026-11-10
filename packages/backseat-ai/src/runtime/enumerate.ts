import { getNextTransitions, getStateNodes } from 'xstate'
import type { AnyMachineSnapshot, AnyStateMachine, AnyStateNode, AnyTransitionDefinition } from 'xstate'
import type { AgentMeta } from './tracking.js'

/** Event descriptors the agent may never take: wildcards, `xstate.*` internals, and the `agent.*` reserved space. */
export function isAgentEvent(descriptor: string): boolean {
  return descriptor !== '*' && !descriptor.endsWith('.*') && !descriptor.startsWith('xstate.') && !descriptor.startsWith('agent.')
}

/** The agent-facing transitions defined on one node (`always` and `after` are never in `transitions` under an agent descriptor). */
export function agentTransitions(node: AnyStateNode): AnyTransitionDefinition[] {
  const out: AnyTransitionDefinition[] = []
  for (const [descriptor, transitions] of node.transitions) {
    if (isAgentEvent(descriptor)) out.push(...transitions)
  }
  return out
}

export function allNodes(machine: AnyStateMachine): AnyStateNode[] {
  const out: AnyStateNode[] = []
  const walk = (node: AnyStateNode) => {
    out.push(node)
    for (const child of Object.values(node.states)) walk(child)
  }
  walk(machine.root)
  return out
}

/** XState ids carry the machine id prefix; the actor id already identifies the machine, so strip it. */
export function stripId(machine: AnyStateMachine, id: string): string {
  const prefix = `${machine.id}.`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

export function metaOf(node: AnyStateNode | AnyTransitionDefinition): AgentMeta | undefined {
  return node.meta as AgentMeta | undefined
}

/** Active nodes, ancestors first. */
export function activeNodes(snapshot: AnyMachineSnapshot): AnyStateNode[] {
  return [...new Set(getStateNodes(snapshot.machine.root, snapshot.value) as AnyStateNode[])].sort((a, b) => a.order - b.order)
}

export function atomicNodes(snapshot: AnyMachineSnapshot): AnyStateNode[] {
  return activeNodes(snapshot).filter((n) => n.type === 'atomic' || n.type === 'final')
}

export type EnabledTransition = {
  type: string
  transition: AnyTransitionDefinition
  /** The named target, or the state the transition is listed under when targetless. */
  target: AnyStateNode
}

/**
 * The transitions the agent may take now, in definition order (child state first, then ancestors).
 * Uses `getTransitionData` for the concrete `{ type }` so the selection among guarded alternatives is exactly
 * the one XState would fire; wildcard-matched and forbidden (no target, no actions, no effect) selections are dropped.
 */
export function enabledTransitions(snapshot: AnyMachineSnapshot): EnabledTransition[] {
  const types = new Set<string>()
  for (const t of getNextTransitions(snapshot)) {
    if (isAgentEvent(t.eventType)) types.add(t.eventType)
  }
  const out: EnabledTransition[] = []
  for (const type of types) {
    for (const transition of selectTransitions(snapshot, { type })) {
      out.push({ type, transition, target: listedUnder(snapshot, transition) })
    }
  }
  return out
}

/** What XState would fire for `event` from this snapshot, minus wildcard matches and forbidden transitions. */
export function selectTransitions(snapshot: AnyMachineSnapshot, event: { type: string }): AnyTransitionDefinition[] {
  let selected: AnyTransitionDefinition[]
  try {
    selected = snapshot.machine.getTransitionData(snapshot, event)
  } catch (error) {
    throw new Error(
      `Guard for '${event.type}' threw while enumerating enabled transitions. ` +
        `Guards on agent-facing transitions may read context but must not read the event payload. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // An effect is something a transition does, so one with an effect and nothing else — a read whose output only `data`
  // shows — is a move, where XState alone would read the empty transition as forbidding the event.
  return selected.filter((t) => t.eventType === event.type && (t.target !== undefined || t.actions.length > 0 || metaOf(t)?.effect !== undefined))
}

function listedUnder(snapshot: AnyMachineSnapshot, transition: AnyTransitionDefinition): AnyStateNode {
  const target = transition.target?.[0]
  if (target) return target
  if (transition.source.parent === undefined) return atomicNodes(snapshot)[0] ?? transition.source
  return transition.source
}
