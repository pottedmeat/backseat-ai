import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { agentTracking, stopCollected } from '../runtime/index.js'
import { createActor } from 'xstate'
import type { AnyStateMachine } from 'xstate'
import { z } from 'zod'

/**
 * A built machine written out as an XState `setup().createMachine()` file for Stately Studio to import
 * (ADR-0010). It is a view, and one way: Studio's importer
 * reads code without running it and keeps only the keys XState knows, so everything Backseat adds is moved to where
 * Studio shows it — the prose into `description`, the rest into `meta` — and nothing comes back.
 *
 * It reads the **built** machine, as the lint does, so what it shows is what registration accepted: the agent-facing
 * keys already under `meta`, the roster in `implementations.actors`. Only `data`'s type needs the source, because a
 * function's return type is not something a running function can say.
 */

/** A lowered config node. XState types it only loosely once built, and every read here is guarded where it matters. */
type Node = Record<string, any>

/** `data`'s return type per state, keyed `<machine id>|<dotted state path>`, from {@link dataTypes}. */
export type DataTypes = Map<string, string>

/** The colour a spawn's transition is drawn in, set apart from every event an agent can send. */
const SPAWN_COLOR = 'purple'

// Backseat's own machinery, spread into every machine by the compiler and never the author's to read.
const TRACKING_CONTEXT = Object.keys(agentTracking.context)
const TRACKING_EVENTS = Object.keys(agentTracking.on)
// The compiler marks a spawn carrying `about` with this and appends that spawn's note right behind it.
const ABOUT = Symbol.for('backseat.about')

const arr = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const q = (text: string) => JSON.stringify(text)
const blockquote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n')
// A running function's own source, which is the only form of an implementation there is by now. A loader that strips
// types (Node's own) blanks them out rather than removing them, and leaves runs of spaces behind.
const source = (fn: Function) => fn.toString().replace(/ {2,}\)/g, ')').replace(/(\S) {2,}(?=\S)/g, '$1 ')
const isSpawn = (action: unknown) => (action as { type?: unknown })?.type === 'xstate.spawnChild'

/** One file to write: its name, and what goes in it. */
export type StatelyFile = { name: string; code: string }

/**
 * A catalog machine and every machine its roster spawns, one file each, so each pastes into Studio on its own. The
 * catalog machine's file is `<name>.stately.ts`; a spawned machine's is its parent's name and its roster key,
 * `<name>.<src>.stately.ts`, and the parent names that file in its `setup({ actors })`.
 */
export function toStately(name: string, machine: AnyStateMachine, types: DataTypes = new Map()): StatelyFile[] {
  const files: StatelyFile[] = []
  const written = new Map<AnyStateMachine, string>()
  const write = (current: AnyStateMachine, stem: string): string => {
    const known = written.get(current)
    if (known) return known
    written.set(current, stem)
    const roster = Object.entries((current.implementations as { actors?: Record<string, unknown> }).actors ?? {})
      .filter((entry): entry is [string, AnyStateMachine] => typeof entry[1] === 'object' && entry[1] !== null && 'root' in entry[1])
      .map(([src, child]) => ({ src, stem: write(child, `${stem}.${src}`) }))
    files.unshift({ name: `${stem}.stately.ts`, code: new Export(current, types).render(roster) })
    return stem
  }
  write(machine, name)
  return files
}

/** A name decided once every implementation is known, so a clash suffixes all its claimants rather than the latecomers. */
type Impl = { base: string; where: string; source: string }

/** One machine's export. Implementations are named as they are met and resolved to their final names at the end. */
class Export {
  private readonly root: Node
  private readonly context: Record<string, unknown>
  private readonly actions: Impl[] = []
  private readonly guards: Impl[] = []
  private readonly outputs: string[] = []
  private readonly eventSchemas = new Map<string, string>()
  private readonly collections: Array<{ state: string; src: string; event: string; target: string | undefined }>

  constructor(
    machine: AnyStateMachine,
    private readonly types: DataTypes,
  ) {
    this.root = machine.config as Node
    this.context = createActor(machine, { input: this.root['meta']?.sampleInput ?? {} }).getSnapshot().context as Record<string, unknown>
    this.collections = collectionsOf(this.root)
  }

  render(roster: ReadonlyArray<{ src: string; stem: string }>): string {
    const { states, ...head }: Node = {
      id: this.root['id'],
      ...(this.root['description'] ? { description: this.root['description'] } : {}),
      context: Object.fromEntries(Object.entries(this.context).filter(([key]) => !TRACKING_CONTEXT.includes(key))),
      ...this.state(this.root, []),
    }
    const actionNames = finalNames(this.actions)
    const guardNames = finalNames(this.guards)
    const lit = (value: unknown) => JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')
    const block = (list: Impl[], finals: string[]) => list.map((impl, i) => `    ${q(finals[i]!)}: ${impl.source.replace(/\n/g, '\n    ')},`).join('\n')
    // A spawned machine is named by the file it is in. Studio's importer drops an actor whose value is a name imported
    // from another file, and keeps any other expression as code, so the path is what reaches its actors list: the
    // file to paste to see that machine. Not actor logic XState would take, which is fine in a file nothing runs.
    const actors = roster.length ? `  actors: {\n${roster.map(({ src, stem }) => `    ${q(src)}: ${q(`./${stem}.stately.ts`)},`).join('\n')}\n  },\n` : ''
    const output = typeof this.root['output'] === 'function' ? `  output: ${source(this.root['output']).replace(/\n/g, '\n  ')},\n` : ''
    const code = `// Written by \`node cli.ts stately\` from a Backseat machine, for viewing in Stately Studio. Nothing reads it back.
import { setup, assign } from 'xstate'

declare function types<T>(): T

export const machine = setup({
${actors}  actions: {
${block(this.actions, actionNames)}
  },
  guards: {
${block(this.guards, guardNames)}
  },
}).createMachine({
${Object.entries(head).map(([key, value]) => `  ${key}: ${lit(value)},`).join('\n')}
  schemas: {
    events: {
${[...this.eventSchemas].map(([event, type]) => `      ${q(event)}: types<${type}>(),`).join('\n')}
    },
  },
${output}  states: ${lit(states)},
})
`
    // Implementations and outputs travel through the JSON as tokens, because their final names and their code are not
    // JSON: the names are only settled once the whole machine has been walked.
    return code
      .replace(/"@@O(\d+)@@"/g, (_, i: string) => this.outputs[Number(i)]!.replace(/\n/g, '\n      '))
      .replace(/@@([AG])(\d+)@@/g, (_, kind: string, i: string) => (kind === 'A' ? actionNames : guardNames)[Number(i)]!)
  }

  private state(node: Node, path: string[]): Node {
    const out: Node = {}
    const where = path.join('.') || '(root)'
    const meta: Node = {}
    const tags = new Set<string>()
    const description: string[] = node['description'] ? [node['description']] : []
    if (node['type']) out['type'] = node['type']
    if (node['initial']) out['initial'] = node['initial']
    const instructions = this.instructions(node['meta']?.instructions)
    if (instructions) {
      description.push(`**Instructions**\n\n${blockquote(instructions)}`)
      meta['instructions'] = instructions
    }
    if (node['meta']?.data) {
      // What the agent is handed, which is the value's type: the function that computes it is the machine's business.
      meta['data'] = this.types.get(`${this.root['id']}|${path.join('.')}`) ?? 'unknown'
      description.push(`**Data**\n\n\`\`\`ts\n${meta['data']}\n\`\`\``)
    }
    const schema = this.schema(node['meta']?.schema)
    if (schema) {
      meta['schema'] = schema.json
      description.push(`**Payload on entry**\n\n${fieldList(schema.json)}`)
    }
    if (description.length && path.length) out['description'] = description.join('\n\n')

    // A spawn is drawn as a transition to where its children are collected, since Studio draws no spawned actor.
    const spawns = [
      ...arr(node['entry']).filter(isSpawn).map((action: Node) => ({ src: String(action['src']), by: 'On entry' })),
      ...Object.entries<unknown>(node['on'] ?? {}).flatMap(([event, ts]) =>
        arr(ts).flatMap((t) => arr((t as Node)?.['actions']).filter(isSpawn).map((action: Node) => ({ src: String(action['src']), by: `When \`${event}\` is taken` }))),
      ),
    ]
    for (const key of ['entry', 'exit'] as const) {
      const acts = this.actionList(node[key], key === 'entry' ? where : `${where}.exit`, tags, key)
      if (acts.length) out[key] = acts
    }
    const on: Node = {}
    for (const [event, ts] of Object.entries<unknown>(node['on'] ?? {})) {
      if (!path.length && TRACKING_EVENTS.includes(event)) continue
      const list = arr(ts).map((t, i) => this.transition(event, typeof t === 'string' ? { target: t } : (t as Node), `${event}${arr(ts).length > 1 ? `#${i}` : ''}`, tags))
      on[event] = list.length === 1 ? list[0] : list
    }
    for (const { src, by } of spawns) {
      tags.add(`spawns:${src}`)
      const drawn = this.collections
        .filter((collection) => collection.state === path.at(-1) && collection.src === src)
        .map((collection) => ({
          ...(collection.target ? { target: collection.target } : {}),
          description: `${by}, an agent is spawned that runs \`${src}\`.`,
          meta: { '@statelyai.color': SPAWN_COLOR, spawn: { src } },
        }))
      on[`spawn:${src}`] = drawn.length === 1 ? drawn[0] : drawn.length ? drawn : { description: `${by}, an agent is spawned that runs \`${src}\`. Nothing collects it.`, meta: { '@statelyai.color': SPAWN_COLOR, spawn: { src } } }
    }
    if (Object.keys(on).length) out['on'] = on
    if (node['onDone']) {
      const list = arr(node['onDone']).map((t, i) => this.transition('', typeof t === 'string' ? { target: t } : (t as Node), `${where}.onDone${arr(node['onDone']).length > 1 ? `#${i}` : ''}`, tags))
      out['onDone'] = list.length === 1 ? list[0] : list
    }
    if (node['always']) out['always'] = arr(node['always']).map((t, i) => this.transition('', t as Node, `${where}.always#${i}`, tags))
    if (path.length && node['output'] !== undefined) {
      out['output'] = `@@O${this.outputs.push(typeof node['output'] === 'function' ? source(node['output']) : JSON.stringify(node['output'])) - 1}@@`
    }
    if (node['states']) {
      out['states'] = Object.fromEntries(Object.entries<Node>(node['states']).map(([key, child]) => [key, this.state(child, [...path, key])]))
    }
    if (tags.size) out['tags'] = [...tags]
    if (Object.keys(meta).length) out['meta'] = meta
    return out
  }

  private transition(event: string, t: Node, where: string, tags: Set<string>): Node {
    const out: Node = {}
    const targets = arr(t['target']).map(String)
    if (targets.length) out['target'] = targets.length === 1 ? targets[0] : targets
    if (t['reenter']) out['reenter'] = true
    const meta: Node = {}
    const description: string[] = t['description'] ? [t['description']] : []
    const schema = this.schema(t['meta']?.schema)
    if (schema) {
      description.push(`**Payload**${schema.derived ? ' _(built from context; shown against the initial context)_' : ''}\n\n${fieldList(schema.json)}`)
      meta['schema'] = schema.json
      if (!this.eventSchemas.has(event)) this.eventSchemas.set(event, tsType(schema.json))
      // A check beyond the payload's types: a payload that matches every field can still be refused.
      if (schema.refined) tags.add(`refines:${event}`)
    }
    for (const site of t['meta']?.settled ?? []) {
      description.push(`**Collects** every \`${site.src}\` spawned in \`${site.state}\`: refused as \`pending-children\` until each has finished.`)
    }
    const effect = t['meta']?.effect
    if (typeof effect === 'function') {
      // Studio has no shape for work done inside a transition, so it is a tag, as everything else the canvas cannot
      // draw is: without it a read that only `data` shows is drawn as a transition that does nothing (ADR-0011).
      tags.add(`effect:${event}`)
      // Refused the way an action refuses, and found the same way: off its own source.
      if (throwsRejection(effect)) tags.add(`may-refuse:${event}`)
    }
    const instructions = this.instructions(t['meta']?.instructions)
    if (instructions) {
      description.push(`**Instructions**\n\n${blockquote(instructions)}`)
      meta['instructions'] = instructions
    }
    if (description.length) out['description'] = description.join('\n\n')
    if (t['guard']) out['guard'] = this.guardName(t['guard'], where)
    const acts = this.actionList(t['actions'], where, tags, event)
    if (acts.length) out['actions'] = acts
    if (Object.keys(meta).length) out['meta'] = meta
    return out
  }

  /** An action list without Backseat's own actions and without spawns, which are drawn as transitions instead. */
  private actionList(actions: unknown, where: string, tags: Set<string>, refusedAt: string): string[] {
    const list = arr(actions)
    const kept = list.filter((action, i) => action !== stopCollected && !isSpawn(action) && !(i > 0 && isSpawn(list[i - 1]) && (list[i - 1] as Node)[ABOUT as never] !== undefined))
    // An action that throws `RejectedEvent` refuses the send (ADR-0007).
    // Read off its source, so a throw inside a helper the action calls is not seen.
    if (kept.some(throwsRejection)) tags.add(`may-refuse:${refusedAt}`)
    return kept.map((action) => this.actionName(action, where))
  }

  private actionName(action: unknown, where: string): string {
    const a = action as Node
    if (a?.['type'] === 'xstate.assign') {
      const assignment = a['assignment']
      if (typeof assignment === 'function') return register(this.actions, 'A', 'assign', where, `assign(${source(assignment)})`)
      const body = Object.entries<unknown>(assignment).map(([key, value]) => `    ${key}: ${typeof value === 'function' ? source(value) : JSON.stringify(value)},`)
      const base = 'set' + Object.keys(assignment).map((key) => key[0]!.toUpperCase() + key.slice(1)).join('')
      return register(this.actions, 'A', base, where, `assign({\n${body.join('\n')}\n  })`)
    }
    const named = typeof action === 'function' && action.name && action.name !== 'actions' ? action.name : `inline@${where}`
    return register(this.actions, 'A', named, where, typeof action === 'function' ? source(action) : JSON.stringify(action))
  }

  /** A hoisted guard keeps the name its `const` gave it; an inline one is named for where it stands. */
  private guardName(guard: unknown, where: string): string {
    if (typeof guard === 'string') return guard
    const fn = guard as Function
    return register(this.guards, 'G', fn.name && fn.name !== 'guard' ? fn.name : `guard@${where}`, where, source(fn))
  }

  private schema(schema: unknown): { json: Node; derived: boolean; refined: boolean } | undefined {
    if (!schema) return undefined
    const derived = typeof schema === 'function'
    const zod = (derived ? (schema as (context: unknown) => z.ZodObject)(this.context) : schema) as z.ZodObject
    const { $schema: _, ...json } = z.toJSONSchema(zod, { io: 'input', unrepresentable: 'any' }) as Node
    return { json, derived, refined: Boolean((zod as Node)['_zod']?.def?.checks?.length) }
  }

  /** Both visits' text where they differ, since a diagram has no visit to resolve against. */
  private instructions(instructions: unknown): string | undefined {
    if (instructions === undefined) return undefined
    if (typeof instructions === 'string') return instructions
    const at = (visit: string) => (instructions as (args: unknown) => string)({ context: this.context, visit })
    const [first, revisit] = [at('first'), at('revisit')]
    return first === revisit ? first : `**First visit:** ${first}\n\n**Revisit:** ${revisit}`
  }
}

/** Every transition that collects children, found before the states are walked so a spawn can be drawn to it. */
function collectionsOf(node: Node): Array<{ state: string; src: string; event: string; target: string | undefined }> {
  return [
    ...Object.entries<unknown>(node['on'] ?? {}).flatMap(([event, ts]) =>
      arr(ts).flatMap((t) => arr((t as Node)?.['meta']?.settled).map((site: Node) => ({ state: site['state'], src: site['src'], event, target: arr((t as Node)['target']).map(String)[0] }))),
    ),
    ...Object.values<Node>(node['states'] ?? {}).flatMap(collectionsOf),
  ]
}

function register(list: Impl[], kind: 'A' | 'G', base: string, where: string, code: string): string {
  let i = list.findIndex((impl) => impl.source === code)
  if (i < 0) i = list.push({ base, where, source: code }) - 1
  return `@@${kind}${i}@@`
}

function finalNames(list: Impl[]): string[] {
  return list.map((impl) => (list.filter((other) => other.base === impl.base).length > 1 ? `${impl.base}@${impl.where}` : impl.base))
}

function throwsRejection(action: unknown): boolean {
  const a = action as Node
  const fns = a?.['type'] === 'xstate.assign' ? (typeof a['assignment'] === 'function' ? [a['assignment']] : Object.values(a['assignment'])) : [action]
  return fns.some((fn) => typeof fn === 'function' && /RejectedEvent/.test(fn.toString()))
}

/** JSON Schema as TypeScript, in the subset Studio's `types<>()` reader understands. */
function tsType(schema: Node | undefined): string {
  if (!schema || typeof schema !== 'object') return 'unknown'
  if ('const' in schema) return JSON.stringify(schema['const'])
  if (schema['enum']) return schema['enum'].map((value: unknown) => JSON.stringify(value)).join(' | ')
  if (schema['anyOf'] ?? schema['oneOf']) return (schema['anyOf'] ?? schema['oneOf']).map(tsType).join(' | ')
  switch (schema['type']) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `Array<${tsType(schema['items'])}>`
    case 'object': {
      const required = new Set(schema['required'] ?? [])
      const props = Object.entries<Node>(schema['properties'] ?? {}).map(([key, value]) => `${/^[a-zA-Z_$][\w$]*$/.test(key) ? key : q(key)}${required.has(key) ? '' : '?'}: ${tsType(value)}`)
      return `{ ${props.join('; ')} }`
    }
  }
  return 'unknown'
}

/** A payload's fields as prose. Studio's importer keeps a schema's types and drops its descriptions, so they go here. */
function fieldList(schema: Node): string {
  const required = new Set(schema['required'] ?? [])
  return Object.entries<Node>(schema['properties'] ?? {})
    .map(([key, value]) => {
      const constraints = [value['format'], value['minItems'] && `at least ${value['minItems']}`, value['minLength'] && 'non-empty', value['minimum'] !== undefined && `≥ ${value['minimum']}`]
        .filter(Boolean)
        .join(', ')
      return `- \`${key}\`${required.has(key) ? '' : ' (optional)'}: \`${tsType(value)}\`${constraints ? ` (${constraints})` : ''}${value['description'] ? ` — ${value['description']}` : ''}`
    })
    .join('\n')
}

/**
 * The TypeScript compiler API, which only `stately` needs, so nothing installs it for the rest of the CLI. It is looked
 * for where the project keeps its own: from the catalog's directory, `typescript5` first — TypeScript 5 under an alias,
 * the way to have it beside TypeScript 7, which has no JavaScript API yet — then `typescript` if that one has the API.
 * Last, from this package, which is where this repo's own development copy is.
 */
async function compilerApi(catalog: string): Promise<typeof import('typescript5')> {
  for (const from of [catalog, fileURLToPath(import.meta.url)]) {
    const require = createRequire(from)
    for (const name of ['typescript5', 'typescript']) {
      let resolved: string
      try {
        resolved = require.resolve(name)
      } catch {
        continue
      }
      const api = ((await import(pathToFileURL(resolved).href)) as { default?: typeof import('typescript5') }).default
      if (typeof api?.createProgram === 'function') return api
    }
  }
  throw new Error(
    `stately reads each state's \`data\` type with the TypeScript compiler API, and found none from ${dirname(catalog)}. ` +
      'Install TypeScript 5 there: `npm install -D typescript@5`, or beside TypeScript 7, which has no API, ' +
      '`npm install -D typescript5@npm:typescript@^5.9`.',
  )
}

/**
 * The type each state's `data` hands the agent, read off the catalog module and everything it imports with the
 * TypeScript checker, named types written out to their shape.
 */
export async function dataTypes(catalog: string): Promise<DataTypes> {
  const ts = await compilerApi(catalog)
  const types: DataTypes = new Map()
  const program = ts.createProgram([catalog], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  })
  const checker = program.getTypeChecker()
  const expand = (type: import('typescript5').Type, indent: string, depth: number): string => {
    if (depth > 6) return checker.typeToString(type)
    if (type.isUnion()) {
      return type.types.every((member) => !(member.flags & ts.TypeFlags.Object)) ? checker.typeToString(type) : type.types.map((member) => expand(member, indent, depth + 1)).join(' | ')
    }
    if (checker.isArrayType(type)) {
      const item = expand(checker.getTypeArguments(type as import('typescript5').TypeReference)[0]!, indent, depth + 1)
      return /[|&]/.test(item) && !item.startsWith('{') ? `(${item})[]` : `${item}[]`
    }
    if (type.flags & ts.TypeFlags.Object && !type.getCallSignatures().length) {
      const props = checker.getPropertiesOfType(type)
      if (!props.length) return '{}'
      const inner = indent + '  '
      const lines = props.map((prop) => `${inner}${prop.name}${prop.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${expand(checker.getTypeOfSymbol(prop), inner, depth + 1)}`)
      return `{\n${lines.join('\n')}\n${indent}}`
    }
    return checker.typeToString(type)
  }
  const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, '')
  // A machine's config is known by its shape, an object with an `id` and `states`, not by the name of the call it is
  // passed to: `backseat()`'s `createMachine` is destructured under whatever name a project likes.
  const machineId = (node: import('typescript5').Node): string | undefined => {
    for (let at: import('typescript5').Node | undefined = node; at; at = at.parent) {
      if (!ts.isObjectLiteralExpression(at) || !at.properties.some((p) => p.name?.getText() === 'states')) continue
      const id = at.properties.find((p) => p.name?.getText() === 'id')
      if (id && ts.isPropertyAssignment(id)) return unquote(id.initializer.getText())
    }
    return undefined
  }
  const statePath = (node: import('typescript5').Node): string[] => {
    const path: string[] = []
    for (let at = node.parent; at; at = at.parent) {
      const states = at.parent?.parent
      if (ts.isPropertyAssignment(at) && ts.isObjectLiteralExpression(at.parent) && states && ts.isPropertyAssignment(states) && states.name.getText() === 'states') {
        path.unshift(unquote(at.name.getText()))
      }
    }
    return path
  }
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || file.fileName.includes('/node_modules/')) continue
    const visit = (node: import('typescript5').Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === 'data' && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const signature = checker.getSignatureFromDeclaration(node.initializer)
        if (signature) types.set(`${machineId(node)}|${statePath(node).join('.')}`, expand(checker.getReturnTypeOfSignature(signature), '', 0))
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return types
}
