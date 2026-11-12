import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A doc that shows a type, a machine or a response the runtime printed is promising the reader that this is what the
// source says. Nothing generates the docs from source, so the promise is kept here instead: every code fence in
// `docs/` and in the `backseat-ai` skill names the file it was taken from, after its language (```ts packages/backseat-ai/src/compiler/machine.ts),
// and must appear in that file word for word. A renamed key, a reworded refusal or a re-recorded response fails here
// rather than leaving a doc that quietly describes something else.
//
// One exception: a fence whose source ends in `@<commit>` quotes a file as it stood at that commit, kept as an example
// after the code it shows was removed. It is not checked against today's source, only against its own claim: if the
// file has the excerpt again, the `@<commit>` is wrong and the fence should be checked like any other.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DOCS = `${ROOT}docs/`
const SKILL = `${ROOT}skills/backseat-ai/`

type Fence = { doc: string; line: number; source: string | undefined; body: string }

/** `doc` is relative to the repo root, so a failure names the file wherever it lives. */
function fences(doc: string): Fence[] {
  const lines = readFileSync(`${ROOT}${doc}`, 'utf8').split('\n')
  const found: Fence[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S*)\s*(\S*)\s*$/.exec(lines[i]!)
    if (!open) continue
    const end = lines.indexOf('```', i + 1)
    if (end === -1) throw new Error(`${doc}:${i + 1}: a code fence that never closes`)
    found.push({ doc, line: i + 1, source: open[2] || undefined, body: lines.slice(i + 1, end).join('\n') })
    i = end
  }
  return found
}

/**
 * Whether `excerpt` appears in `source`, word for word. Only each line's leading whitespace is let go, so a member
 * quoted out of a nested object may be dedented; anything else that differs, down to one character, is drift.
 */
function quotes(source: string, excerpt: string): boolean {
  const flat = (text: string) => text.split('\n').map((line) => line.trimStart()).join('\n')
  return excerpt.trim() !== '' && flat(source).includes(flat(excerpt).trim())
}

describe('the check that keeps docs in step with source', () => {
  it('lets a quote be dedented, and nothing else', () => {
    const source = "  on: {\n    finish: {\n      target: 'done',\n    },\n  },"
    expect(quotes(source, "finish: {\n  target: 'done',\n},")).toBe(true)
    expect(quotes(source, "finish: {\n  target: 'finished',\n},")).toBe(false)
    expect(quotes(source, "finish: {\n},")).toBe(false)
    expect(quotes(source, '')).toBe(false)
  })
})

describe('the docs and the skill', () => {
  const docs = readdirSync(DOCS).filter((name) => name.endsWith('.md'))
  // The skill quotes the demos as the docs do, and an excerpt that drifted would teach a pattern the code no longer has.
  const skill = readdirSync(SKILL, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.md'))
  const all = [...docs.map((name) => `docs/${name}`), ...skill.map((name) => `skills/backseat-ai/${name}`)].flatMap(fences)

  it('are found, so a moved directory cannot pass by checking nothing', () => {
    expect(docs).toContain('xstate.md')
    expect(skill).toContain('SKILL.md')
  })

  it.each(all.map((f) => [`${f.doc}:${f.line}`, f] as const))('%s names its source and quotes it word for word', (_, fence) => {
    expect(fence.source, 'name the file this was taken from after the fence language').toBeDefined()
    const [file, retiredAt] = fence.source!.split('@')
    const path = `${ROOT}${file}`
    expect(existsSync(path), `${file} does not exist`).toBe(true)
    const quoted = quotes(readFileSync(path, 'utf8'), fence.body)
    if (retiredAt) expect(quoted, `${file} has this excerpt, so drop the @${retiredAt}`).toBe(false)
    else expect(quoted, `not in ${fence.source} word for word`).toBe(true)
  })
})
