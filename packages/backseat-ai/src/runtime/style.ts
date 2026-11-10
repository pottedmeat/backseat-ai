import { createActor } from 'xstate'
import type { AnyMachineSnapshot, AnyStateMachine, AnyStateNode, AnyTransitionDefinition } from 'xstate'
import { allNodes, metaOf, stripId } from './enumerate.js'
import { sitesOf } from './sites.js'
import registry from './style-rules.json' with { type: 'json' }

/**
 * The style rules a walk over the built machine can establish exactly — four of them, across five checks. The rest
 * of writing a machine well is judgement, and belongs to a reviewer rather than here.
 *
 * **The bargain is that this is never wrong.** A lint that fires on a third of what it sees gets ignored within a
 * month, and then there is no lint. So every check here either states a fact that is exactly true, or **declines** —
 * saying what it could not see and reporting nothing. Silence is always available; a wrong finding is not. Three
 * checks decline under a stated precondition, and each says so rather than passing quietly.
 *
 * A finding is a **fact, not a verdict**. `data.pr` being carried by every transition that reaches the state is
 * exactly true; whether that makes it noise is the rule's claim, which the author reads from the rule's `why`.
 */
export type Finding = {
  /** The rule in [`style-rules.json`](./style-rules.json) this fact bears on. */
  rule: RuleId
  /** The state or transition, as the agent sees it. */
  where: string
  /** What is exactly true. Never a judgement, never an instruction. */
  fact: string
}

/** What the check would have needed in order to speak, and did not have. */
export type Declined = { rule: RuleId; because: string }

export type Report = { machine: string; findings: Finding[]; declined: Declined[] }

/** The rules a check here bears on. Each is an entry in `style-rules.json`, whose `id` is the stable name of the rule. */
export type RuleId = 'data-only-across-readers' | 'bound-every-loop' | 'spend-the-last-word' | 'store-nothing-unread'

/**
 * A rule as a person reads it off a finding: what it is called and why it holds. The registry is JSON so the rule's
 * identity lives in one document other tooling can read, and a finding carries its own explanation rather than
 * pointing at a file.
 */
export type StyleRule = { id: RuleId; title: string; why: string }

const RULES: readonly StyleRule[] = registry as StyleRule[]

/** The registry entry for `id`. Throws when the registry lacks one, which is a registry out of step with this file. */
export function styleRule(id: RuleId): StyleRule {
  const rule = RULES.find((r) => r.id === id)
  if (rule === undefined) throw new Error(`style-rules.json has no rule '${id}'`)
  return rule
}

const EVERY_RULE: RuleId[] = ['data-only-across-readers', 'bound-every-loop', 'spend-the-last-word', 'store-nothing-unread']

/**
 * Every fact the five checks (over four rules) can establish about one built machine. Never throws for a machine registration accepted:
 * a check that cannot compute its precondition declines instead.
 */
export function lintMachine(name: string, machine: AnyStateMachine): Report {
  const findings: Finding[] = []
  const declined: Declined[] = []
  const nodes = allNodes(machine)
  const where = (node: AnyStateNode) => stripId(machine, node.id)

  let context: unknown
  try {
    const snapshot = createActor(machine, { input: metaOf(machine.root)?.sampleInput ?? {} }).getSnapshot() as AnyMachineSnapshot
    if (snapshot.status === 'error') throw snapshot.error
    context = snapshot.context
  } catch (error) {
    // Registration computes this same snapshot and refuses the machine when it cannot. Reaching here means the lint
    // was pointed at something registration never saw, so every check declines rather than guessing at a context.
    const because = `the initial snapshot could not be computed: ${error instanceof Error ? error.message : String(error)}`
    return { machine: name, findings: [], declined: EVERY_RULE.map((rule) => ({ rule, because })) }
  }

  finalStatesWithNothingToSay(machine, nodes, where, findings)
  finalStatesSayingTheSameThing(machine, nodes, where, findings, declined)
  loopsWithNoWayOut(nodes, where, findings, declined)
  dataAlreadyCarried(machine, nodes, context, where, findings, declined)
  contextNobodyReads(machine, nodes, context, findings, declined)

  return { machine: name, findings, declined }
}

// --- spend-the-last-word -------------------------------------------------------------------------------------------

/**
 * Arriving at a final state delivers its instructions and closes the actor, so it is the one place in a machine where
 * prose has no next call to lean on. Having none at all is exact: the last thing the agent reads is nothing.
 *
 * **Only a final state of the root.** A final state nested in a compound region ends the region, not the actor —
 * `onDone` fires straight away and the agent reads the state that follows, never this one's instructions. So a
 * region's ending, such as `deep-research`'s `citing.accepted`, is not a wasted ending and must not be reported as one.
 *
 * Restricted also to a final state something actually targets. A final state no transition reaches is a different
 * problem, and claiming an unreachable state wasted its last words would be a finding about a state nobody arrives at.
 */
function finalStatesWithNothingToSay(machine: AnyStateMachine, nodes: AnyStateNode[], where: (n: AnyStateNode) => string, out: Finding[]): void {
  const targeted = new Set<AnyStateNode>()
  for (const node of nodes) for (const t of allTransitions(node)) for (const target of t.target ?? []) for (const entry of entriesOf(target)) targeted.add(entry)
  for (const node of nodes) {
    if (node.type !== 'final' || node.parent !== machine.root) continue
    if (!targeted.has(node)) continue
    if (metaOf(node)?.instructions !== undefined) continue
    out.push({ rule: 'spend-the-last-word', where: where(node), fact: 'is a final state with no instructions: arriving there closes the actor having said nothing' })
  }
}

/**
 * Endings were split to record a distinction, and one form of words shared between two of them throws it away.
 *
 * Endings of the root, for the same reason as above. A final state whose instructions are a **function** is not
 * compared — two functions can return the same string against the registration context and different strings against
 * a live one — and the check **declines** rather than passing over it quietly: a run that dropped an ending without
 * saying so reads as a machine whose endings were all checked.
 */
function finalStatesSayingTheSameThing(
  machine: AnyStateMachine,
  nodes: AnyStateNode[],
  where: (n: AnyStateNode) => string,
  out: Finding[],
  declined: Declined[],
): void {
  const byProse = new Map<string, AnyStateNode[]>()
  const computed: string[] = []
  for (const node of nodes) {
    if (node.type !== 'final' || node.parent !== machine.root) continue
    const instructions = metaOf(node)?.instructions
    if (typeof instructions === 'function') computed.push(where(node))
    if (typeof instructions !== 'string') continue
    byProse.set(instructions, [...(byProse.get(instructions) ?? []), node])
  }
  if (computed.length) {
    declined.push({
      rule: 'spend-the-last-word',
      because: `instructions on ${computed.sort().join(', ')} ${computed.length === 1 ? 'is a function' : 'are functions'}, which two endings could resolve alike here and differently against a live context`,
    })
  }
  for (const [prose, sharing] of byProse) {
    if (sharing.length < 2) continue
    const names = sharing.map(where)
    out.push({
      rule: 'spend-the-last-word',
      where: names.join(', '),
      fact: `are ${names.length} final states whose instructions are the same string: ${JSON.stringify(prose.length > 60 ? `${prose.slice(0, 57)}...` : prose)}`,
    })
  }
}

// --- bound-every-loop ----------------------------------------------------------------------------------------------

/**
 * A set of states you can circulate through forever with no transition leaving it. Plain reachability over the built
 * machine, where every target is already resolved — exact, and it does not need to read a guard.
 *
 * What it does **not** check is the rule's actual subject: whether the way out opens exactly as the way round shuts.
 * That needs the guards, which are opaque functions, so it stays with the reviewer.
 *
 * **Declines on a machine with a parallel node**, where "the state you are in" is a set rather than a node and a
 * component of single nodes is no longer the thing that can be stuck.
 */
function loopsWithNoWayOut(
  nodes: AnyStateNode[],
  where: (n: AnyStateNode) => string,
  out: Finding[],
  declined: Declined[],
): void {
  if (nodes.some((node) => node.type === 'parallel')) {
    declined.push({ rule: 'bound-every-loop', because: 'the machine has a parallel node, where being stuck is a property of a set of states rather than of one' })
    return
  }
  const graph = graphOf(nodes)
  const standable = [...graph.keys()]
  const edges = new Map([...graph].map(([node, out]) => [node, new Set(out.map((edge) => edge.to))]))
  for (const component of stronglyConnected(standable, edges)) {
    const inside = new Set(component)
    const circulates = component.length > 1 || component.some((node) => edges.get(node)?.has(node))
    if (!circulates) continue
    if (component.some((node) => [...(edges.get(node) ?? [])].some((target) => !inside.has(target)))) continue
    const names = component.map(where).sort()
    out.push({
      rule: 'bound-every-loop',
      where: names.join(', '),
      fact: names.length === 1 ? 'transitions only to itself: no transition leaves it' : `form a cycle no transition leaves: ${names.join(' -> ')} and back`,
    })
  }
}

// --- data-only-across-readers --------------------------------------------------------------------------------------

/**
 * `data` is how a value one driver stated reaches **another** driver. A key republished to the driver that sent it is
 * a copy of something that driver already holds.
 *
 * The comparison is against the transitions that **dominate** the state — the ones every path from the initial state
 * to it must have taken — not the ones that reach it directly, against which a state reached two ways shows nothing. A driver holds its whole conversation, so a key
 * it sent three states ago is still in its hands; `building` is reached both from `triaging` and from a second review
 * round, and on either arrival the driver has already sent what `triage.gaps` carried.
 *
 * The rule has one escape hatch written into it — a value written by one actor and read by another — and a checker
 * cannot see into another driver's head. So this **declines on any machine that spawns**: an empty roster with no
 * spawn site anywhere is the precondition under which the machine provably has one driver and the hatch cannot apply.
 * It declines on a parallel node too, where dominance over single states is not the question.
 *
 * Exact under one assumption registration already rests on: a `data` projection is an object literal whose key set is
 * fixed, so calling it with the registration context gives the keys it will ever emit.
 *
 * **What it cannot see is repackaging.** `triaging` published `data.pr`, assembled by its incoming transition out of
 * the `url`, `title`, `base`, `head` and `changedFiles` the driver sent. No key comparison finds that, because no key
 * matches. It stays a question for the reviewer.
 */
function dataAlreadyCarried(
  machine: AnyStateMachine,
  nodes: AnyStateNode[],
  context: unknown,
  where: (n: AnyStateNode) => string,
  out: Finding[],
  declined: Declined[],
): void {
  const roster = Object.keys((machine.implementations as { actors?: Record<string, unknown> }).actors ?? {})
  if (roster.length > 0 || nodes.some((node) => sitesOf(node).length > 0)) {
    declined.push({ rule: 'data-only-across-readers', because: 'the machine spawns, so a key the driver here already holds may still be read by a child driver that does not' })
    return
  }
  if (nodes.some((node) => node.type === 'parallel')) {
    declined.push({ rule: 'data-only-across-readers', because: 'the machine has a parallel node, where what the driver must already have sent on arrival is not a question about one path' })
    return
  }
  const graph = graphOf(nodes)
  const dominating = dominators(machine, graph)
  for (const node of nodes) {
    const project = metaOf(node)?.data
    if (project === undefined) continue
    const already = dominating.get(node)
    // Unreachable, or the state the machine starts in: nothing was necessarily sent before arriving.
    if (already === undefined || already.size === 0) continue
    let emitted: string[]
    try {
      emitted = Object.keys((project({ context }) ?? {}) as object)
    } catch {
      declined.push({ rule: 'data-only-across-readers', because: `meta.data on '${where(node)}' threw on the registration context` })
      continue
    }
    for (const key of emitted) {
      const sender = [...already].find((t) => schemaKeys(t, context)?.includes(key))
      if (sender === undefined) continue
      out.push({
        rule: 'data-only-across-readers',
        where: where(node),
        fact: `publishes \`data.${key}\`, and every path here has already taken '${sender.eventType}', whose schema carries \`${key}\``,
      })
    }
  }
}

/** A transition's payload keys, or `undefined` where the schema is absent or could not be resolved against context. */
function schemaKeys(t: AnyTransitionDefinition, context: unknown): string[] | undefined {
  const schema = metaOf(t)?.schema
  if (schema === undefined) return undefined
  try {
    const resolved = typeof schema === 'function' ? schema(context) : schema
    return Object.keys((resolved as { shape?: object }).shape ?? {})
  } catch {
    return undefined
  }
}

// --- store-nothing-unread ------------------------------------------------------------------------------------------

/**
 * A context field nothing reads is a museum piece: the agent still has the value because it sent it, so the copy buys
 * nothing and makes the run record look as though the machine knows something.
 *
 * **Read off each reader's own source text, not by running it.** Running a reader against a probe context would find
 * what a *particular* context makes it read, and a field read inside an `if` would come back dead — the one direction
 * this must never be wrong in. Source text over-approximates the readers instead, so the check goes quiet rather than
 * accusing a live field.
 *
 * It declines outright when a reader **calls a helper**, because a helper's body is not reachable from the built
 * machine and a field read only in there would look dead. Hoisting a guard to a const is the fix, and is what the
 * run record wants anyway.
 *
 * The readers it sees are six: a guard, a context-derived schema, a state's `data`, the root's `output`, a
 * transition's `effect`, and **`instructions` in its function form**, which reads context like any other.
 *
 * **Readers it cannot see are still readers.** A spawn's `id`, `input` and `about` are functions of context, and so is
 * any ordinary action, and none of them is collected here. A field read only there — `deep-research`'s
 * `context.dispatched` is one — has a reader, and this check would report it; on `deep-research` it declines for
 * another reason first. On a machine with a spawn site, what this check reports is the reviewer's to confirm.
 */
function contextNobodyReads(machine: AnyStateMachine, nodes: AnyStateNode[], context: unknown, out: Finding[], declined: Declined[]): void {
  const fields = Object.keys((context ?? {}) as object).filter((key) => key !== 'agent')
  if (fields.length === 0) return

  const readers: string[] = []
  const add = (value: unknown) => {
    // Strings and comments are stripped before matching: `instructions` is a reader whose source is mostly English,
    // and a context field is often an ordinary word — `plan`, `gaps`, `intent` — that the prose uses. Matching raw
    // source would call such a field alive because a sentence says it.
    if (typeof value === 'function') readers.push(stripProse(Function.prototype.toString.call(value)))
  }
  add(machine.root.output)
  for (const node of nodes) {
    const meta = metaOf(node)
    add(meta?.data)
    add(meta?.schema)
    add(meta?.instructions)
    for (const t of allTransitions(node)) {
      const tmeta = metaOf(t)
      add(tmeta?.schema)
      add(tmeta?.instructions)
      add(tmeta?.effect)
      for (const guard of guardsOf(t)) add(guard)
    }
  }

  const opaque = [...new Set(readers.flatMap(callsOut))].sort()
  if (opaque.length > 0) {
    declined.push({
      rule: 'store-nothing-unread',
      because: `a reader calls ${opaque.map((n) => `${n}()`).join(', ')}, whose body the built machine does not carry; a field read only in there would look unread`,
    })
    return
  }

  for (const field of fields) {
    // A preceding dot must count: a guard reads through `context.`, so `context.checks` is the canonical read.
    // `other.checks` counts too, which over-approximates the readers — the direction this is allowed to be wrong in.
    const named = new RegExp(`(?<![\\w$])${escapeForRegExp(field)}(?![\\w$])`)
    if (readers.some((source) => named.test(source))) continue
    out.push({
      rule: 'store-nothing-unread',
      where: `context.${field}`,
      fact: 'is named by no guard, context-derived schema, `data` projection, instruction block, `effect` or the root `output`',
    })
  }
}

/** Every guard function reachable on a transition, including the leaves of a composed `and`/`or`/`not`. */
function guardsOf(t: AnyTransitionDefinition): unknown[] {
  const found: unknown[] = []
  const walk = (guard: unknown) => {
    if (typeof guard === 'function') return void found.push(guard)
    if (typeof guard !== 'object' || guard === null) return
    const params = (guard as { params?: unknown }).params
    if (Array.isArray(params)) params.forEach(walk)
    else if (params !== undefined) walk(params)
  }
  walk((t as { guard?: unknown }).guard)
  return found
}

/**
 * Bare identifiers a function's source calls: `isDone(context)` but not `z.object(...)`, `items.map(...)` or a
 * keyword taking a parenthesised head, `async (...) =>` among them. `RejectedEvent` is Backseat's own and reads only
 * what it is handed. Anything left is a body this check cannot see into.
 */
const CALL = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g
const VISIBLE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'async', 'function', 'Object', 'Array', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Set', 'Map', 'Date', 'BigInt', 'Symbol', 'RegExp', 'Error', 'Promise', 'RejectedEvent'])
function callsOut(source: string): string[] {
  return [...source.matchAll(CALL)].map((m) => m[1]!).filter((name) => !VISIBLE.has(name))
}

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A function's source with its strings and comments blanked out, keeping the `${...}` of a template, which is code.
 * A field is never read from inside a string literal, and a comment naming one is not a reader either.
 */
function stripProse(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    if (c === '\'' || c === '"') {
      i += 1
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1
      i += 1
      out += ' '
      continue
    }
    if (c === '`') {
      i += 1
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '$' && source[i + 1] === '{') {
          let depth = 1
          i += 2
          out += ' '
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1
            else if (source[i] === '}') depth -= 1
            if (depth > 0) out += source[i]
            i += 1
          }
          continue
        }
        i += 1
      }
      i += 1
      out += ' '
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    out += c
    i += 1
  }
  return out
}

// --- walking -------------------------------------------------------------------------------------------------------

/** Every transition defined on a node, agent-facing or not: reachability does not care who sends it. `always` is not in the map. */
function allTransitions(node: AnyStateNode): AnyTransitionDefinition[] {
  const always = (node as unknown as { always?: AnyTransitionDefinition[] }).always ?? []
  return [...[...node.transitions.values()].flat(), ...always]
}

const lineage = (node: AnyStateNode): AnyStateNode[] => (node.parent ? [...lineage(node.parent), node] : [node])

/** One move: the state it lands in, and the transition that made it. */
type Edge = { to: AnyStateNode; via: AnyTransitionDefinition }

/**
 * The states you can stand in, and the moves out of each. A transition written on an ancestor is available from every
 * descendant, which is the whole point of writing it there, so each node's moves are its lineage's.
 */
function graphOf(nodes: AnyStateNode[]): Map<AnyStateNode, Edge[]> {
  const graph = new Map<AnyStateNode, Edge[]>()
  for (const node of nodes) {
    if (node.type !== 'atomic' && node.type !== 'final') continue
    const out: Edge[] = []
    for (const source of lineage(node)) {
      for (const via of allTransitions(source)) {
        for (const target of via.target ?? []) for (const to of entriesOf(target)) out.push({ to, via })
      }
    }
    graph.set(node, out)
  }
  return graph
}

/**
 * For each reachable state, the transitions every path from the start must have taken to arrive there. The driver
 * holds everything it has sent, so this — not the set of transitions that merely reach the state — is what it already
 * has in hand when it gets there. Ordinary dominator dataflow, run to a fixed point over a handful of states.
 */
function dominators(machine: AnyStateMachine, graph: Map<AnyStateNode, Edge[]>): Map<AnyStateNode, Set<AnyTransitionDefinition>> {
  const start = entriesOf(machine.root)[0]
  if (!start || !graph.has(start)) return new Map()
  const incoming = new Map<AnyStateNode, Edge[]>()
  for (const [from, out] of graph) for (const edge of out) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), { to: from, via: edge.via }])

  const reachable = new Set<AnyStateNode>([start])
  const queue = [start]
  while (queue.length) for (const edge of graph.get(queue.pop()!) ?? []) if (!reachable.has(edge.to)) (reachable.add(edge.to), queue.push(edge.to))

  const everything = new Set([...graph.values()].flat().map((edge) => edge.via))
  const dom = new Map<AnyStateNode, Set<AnyTransitionDefinition>>()
  for (const node of reachable) dom.set(node, node === start ? new Set() : new Set(everything))
  for (let settled = false; !settled; ) {
    settled = true
    for (const node of reachable) {
      if (node === start) continue
      let next: Set<AnyTransitionDefinition> | undefined
      for (const { to: from, via } of incoming.get(node) ?? []) {
        if (!reachable.has(from)) continue
        const through = new Set([...dom.get(from)!, via])
        next = next === undefined ? through : new Set([...next].filter((t) => through.has(t)))
      }
      next ??= new Set()
      if (next.size === dom.get(node)!.size) continue
      dom.set(node, next)
      settled = false
    }
  }
  return dom
}

/** The atomic states entering `node` actually puts you in: its initial descendants, or one per region of a parallel node. */
function entriesOf(node: AnyStateNode): AnyStateNode[] {
  if (node.type === 'parallel') return Object.values(node.states).flatMap(entriesOf)
  const next = node.initial?.target?.[0]
  if (!next || next === node) return [node]
  return entriesOf(next)
}

/** Tarjan, iterative-free: the machines here are small and the recursion is bounded by the state count. */
function stronglyConnected(nodes: AnyStateNode[], edges: Map<AnyStateNode, Set<AnyStateNode>>): AnyStateNode[][] {
  const index = new Map<AnyStateNode, number>()
  const low = new Map<AnyStateNode, number>()
  const onStack = new Set<AnyStateNode>()
  const stack: AnyStateNode[] = []
  const components: AnyStateNode[][] = []
  let next = 0
  const visit = (node: AnyStateNode) => {
    index.set(node, next)
    low.set(node, next)
    next += 1
    stack.push(node)
    onStack.add(node)
    for (const target of edges.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target)
        low.set(node, Math.min(low.get(node)!, low.get(target)!))
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!))
      }
    }
    if (low.get(node) !== index.get(node)) return
    const component: AnyStateNode[] = []
    for (;;) {
      const popped = stack.pop()!
      onStack.delete(popped)
      component.push(popped)
      if (popped === node) break
    }
    components.push(component)
  }
  for (const node of nodes) if (!index.has(node)) visit(node)
  return components
}
