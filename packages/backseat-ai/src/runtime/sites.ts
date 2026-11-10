import type { AnyStateMachine, AnyStateNode, AnyTransitionDefinition } from 'xstate'
import { allNodes, metaOf, stripId } from './enumerate.js'

/**
 * Spawn sites: a state plus one machine it spawns, read by `createMachine` off the `spawnChild` actions the state runs
 * and carried on its `meta.sites`; `settled` on a transition is carried on its `meta.settled`
 * (ADR-0008).
 */
export type Site = { src: string }
/**
 * One entry of a transition's `settled`: the state (its id as the agent sees it) and the machine spawned there
 * (ADR-0008).
 */
export type SettledSite = { state: string; src: string }

export function sitesOf(node: AnyStateNode): Site[] {
  return metaOf(node)?.sites ?? []
}

/** The fixed sentence a `settled` transition is annotated with. */
export function requiresSentence(settled: SettledSite[]): string {
  return settled.map((r) => `every child spawned at ${r.state} (${r.src}) settled`).join(', ')
}

function transitionsOf(node: AnyStateNode): AnyTransitionDefinition[] {
  const always = (node as unknown as { always?: AnyTransitionDefinition[] }).always ?? []
  return [...[...node.transitions.values()].flat(), ...always]
}

const lineage = (node: AnyStateNode): AnyStateNode[] => (node.parent ? [...lineage(node.parent), node] : [node])

/** The states a transition enters, statically: each target, its ancestors below the source's lineage, and its initial descendants. */
function enteredStatically(t: AnyTransitionDefinition): AnyStateNode[] {
  const sourceLine = lineage(t.source)
  const out: AnyStateNode[] = []
  for (const target of t.target ?? []) {
    for (const node of lineage(target)) if (node === target || !sourceLine.includes(node)) out.push(node)
    let node: AnyStateNode | undefined = target
    while (node && node.initial.target[0] && node.initial.target[0] !== node) {
      node = node.initial.target[0]
      out.push(node)
    }
  }
  return out
}

/**
 * The cross-node checks on a machine: every `settled` names a site that exists, and no transition can reach two sites of one `src`, since a child is attributed to the transition and
 * never to the action, and every site is required settled by some transition — under ADR-0008 a site
 * nothing collects discards its children's results silently. Warnings: an entry of `roster` (the definition's `actors`) no site uses.
 */
export function checkSites(machine: AnyStateMachine, roster: string[] = []): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const nodes = allNodes(machine)
  const id = (node: AnyStateNode) => stripId(machine, node.id)
  const byId = new Map(nodes.map((node) => [id(node), node]))
  const required = new Set<string>()
  for (const source of nodes) {
    for (const t of transitionsOf(source)) {
      const where = `'${t.eventType}' from '${id(source)}'`
      const settled = metaOf(t)?.settled
      if (settled !== undefined) {
        for (const entry of settled) {
          const node = byId.get(entry.state)
          if (!node) {
            errors.push(`${where} requires settled at '${entry.state}', which is not a state`)
            continue
          }
          const sites = sitesOf(node)
          if (!sites.some((s) => s.src === entry.src)) {
            errors.push(`${where} requires settled at '${entry.state}' (${entry.src}), which is not a spawn site there${sites.length ? `; its sites are ${sites.map((s) => s.src).join(', ')}` : ''}`)
          }
          required.add(`${entry.state}\0${entry.src}`)
        }
      }
      const reachable = [source, ...enteredStatically(t)]
      const seen = new Map<string, AnyStateNode>()
      for (const node of reachable) {
        for (const site of sitesOf(node)) {
          const other = seen.get(site.src)
          if (other && other !== node) errors.push(`${where} can reach two spawn sites of '${site.src}' ('${id(other)}' and '${id(node)}'); a child could not be filed under one`)
          else seen.set(site.src, node)
        }
      }
    }
  }
  const used = new Set(nodes.flatMap((node) => sitesOf(node).map((s) => s.src)))
  for (const name of roster) {
    if (!used.has(name)) warnings.push(`actors.${name} is spawned by no state; it is dead, or spawned by code no site declares`)
  }
  for (const node of nodes) {
    for (const site of sitesOf(node)) {
      if (required.has(`${id(node)}\0${site.src}`)) continue
      // ADR-0008 raised this from a warning: the collection is the only thing that ever reads a child's result, so a
      // site no transition requires settled does not merely leak children — it discards what they returned, in silence.
      errors.push(`spawn site '${site.src}' at '${id(node)}' is required settled by no transition; its children are never collected, so their results are discarded`)
    }
  }
  return { errors, warnings }
}
