import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pinVersion, readPin } from './pin.js'

/**
 * The pin is process-global — `module.registerHooks()` affects every later import in the process — so it is exercised
 * the only way that is honest: in child processes, one capturing and one serving, with the source edited in between.
 * What is asserted is the claim the mechanism exists to make: **the run runs the code it started with.**
 */
// The child loads the source directly — Node strips the types — so the test needs no build step.
const PIN_JS = fileURLToPath(new URL('./pin.ts', import.meta.url))

describe('the pin', () => {
  let dir: string
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text)
  const node = (script: string) => execFileSync(process.execPath, [join(dir, script)], { encoding: 'utf8', cwd: dir }).trim()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backseat-pin-'))
    write('dep.ts', "export const answer: string = 'ORIGINAL'\nexport const namedGuard = (n: number) => n > 0\n")
    write('entry.ts', "export { answer, namedGuard } from './dep.ts'\n")
    write(
      'capture.mjs',
      `import { capturePin } from ${JSON.stringify(PIN_JS)}
import { pathToFileURL } from 'node:url'
const session = capturePin()
const m = await import(pathToFileURL('${dir}/entry.ts').href)
session.write('${dir}', 'r1')
console.log(JSON.stringify({ answer: m.answer, version: session.version() }))
`,
    )
    write(
      'serve.mjs',
      `import { servePin } from ${JSON.stringify(PIN_JS)}
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const session = servePin(JSON.parse(readFileSync('${dir}/r1.pin.json', 'utf8')))
try {
  const m = await import(pathToFileURL('${dir}/entry.ts').href)
  console.log(JSON.stringify({ answer: m.answer, guardName: m.namedGuard.name, version: session.version() }))
} catch (error) {
  console.log(JSON.stringify({ refused: error.name, message: error.message }))
}
`,
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('serves the code the run started with after the source is edited', () => {
    const captured = JSON.parse(node('capture.mjs')) as { answer: string; version: string }
    expect(captured.answer).toBe('ORIGINAL')

    write('dep.ts', "export const answer: string = 'EDITED'\nexport const namedGuard = (n: number) => n > 0\n")
    const served = JSON.parse(node('serve.mjs')) as { answer: string; version: string }
    expect(served.answer).toBe('ORIGINAL')
    // The version names the code, not the run: the same pin digests the same either side.
    expect(served.version).toBe(captured.version)
  })

  it('survives the file being deleted, which resolution alone would not', () => {
    node('capture.mjs')
    rmSync(join(dir, 'dep.ts'))
    // `load` alone is never reached here: resolution fails first with ERR_MODULE_NOT_FOUND, which is why the pin
    // registers a `resolve` hook too and short-circuits to the URL it recorded.
    expect((JSON.parse(node('serve.mjs')) as { answer: string }).answer).toBe('ORIGINAL')
  })

  it('survives the file being renamed', () => {
    node('capture.mjs')
    renameSync(join(dir, 'dep.ts'), join(dir, 'moved.ts'))
    expect((JSON.parse(node('serve.mjs')) as { answer: string }).answer).toBe('ORIGINAL')
  })

  it('keeps a function name byte-identical, which is what the journey records a guard by', () => {
    node('capture.mjs')
    write('dep.ts', "export const answer: string = 'EDITED'\nexport const namedGuard = (n: number) => n > 0\n")
    // `Step.guard` is `fn.name` on the new surface, so a served module has to carry names as a live load does.
    expect((JSON.parse(node('serve.mjs')) as { guardName: string }).guardName).toBe('namedGuard')
  })

  it('refuses an import that was not in the pin, rather than silently running the current file', () => {
    node('capture.mjs')
    write('lazy.ts', "export const late: string = 'LATE'\n")
    write(
      'late.mjs',
      `import { servePin } from ${JSON.stringify(PIN_JS)}
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
servePin(JSON.parse(readFileSync('${dir}/r1.pin.json', 'utf8')))
try {
  await import(pathToFileURL('${dir}/lazy.ts').href)
  console.log(JSON.stringify({ refused: false }))
} catch (error) {
  console.log(JSON.stringify({ refused: true, name: error.name, message: error.message }))
}
`,
    )
    const result = JSON.parse(node('late.mjs')) as { refused: boolean; name?: string; message?: string }
    // Lenient was measured and rejected: a module down a branch the create call never took would run edited code
    // with no error at all, which is the failure the pin exists to remove.
    expect(result.refused).toBe(true)
    expect(result.name).toBe('NotPinned')
    expect(result.message).toContain('lazy.ts')
    expect(result.message).toContain('not in the run snapshot')
  })

  it('does not hold a module that was in the cache before it was registered, which is how a bin learns its entry imported the catalog', () => {
    write(
      'early.mjs',
      `import ${JSON.stringify(`${dir}/entry.ts`)}
import { capturePin } from ${JSON.stringify(PIN_JS)}
import { pathToFileURL } from 'node:url'
const session = capturePin()
const entry = pathToFileURL('${dir}/entry.ts').href
await import(entry)
console.log(JSON.stringify({ held: session.has(entry), version: session.version() }))
`,
    )
    // The static import above is hoisted ahead of the hooks; the dynamic one then hits the cache and the hooks never
    // see the module. Nothing was captured, and the session says so rather than writing an empty pin as a real one.
    expect(JSON.parse(node('early.mjs'))).toEqual({ held: false, version: undefined })
    node('capture.mjs')
    write(
      'held.mjs',
      `import { capturePin } from ${JSON.stringify(PIN_JS)}
import { pathToFileURL } from 'node:url'
const session = capturePin()
const entry = pathToFileURL('${dir}/entry.ts').href
await import(entry)
console.log(JSON.stringify({ held: session.has(entry) }))
`,
    )
    expect(JSON.parse(node('held.mjs'))).toEqual({ held: true })
  })

  it('writes a pin the run directory can be read back from, digested over its modules', () => {
    node('capture.mjs')
    const pin = readPin(dir, 'r1')!
    expect(pin).toBeDefined()
    expect(Object.keys(pin.modules).some((url) => url.endsWith('/dep.ts'))).toBe(true)
    expect(Object.keys(pin.modules).some((url) => url.endsWith('/entry.ts'))).toBe(true)
    // Every module carries a format: a CJS file reports none, and handing that back throws ERR_UNKNOWN_MODULE_FORMAT.
    for (const module_ of Object.values(pin.modules)) expect(typeof module_.format).toBe('string')
    expect(pinVersion(pin)).toMatch(/^[0-9a-f]{12}$/)
    // The digest is of the code, so re-reading the same pin names it the same.
    expect(pinVersion(JSON.parse(readFileSync(join(dir, 'r1.pin.json'), 'utf8')))).toBe(pinVersion(pin))
  })
  it('refuses a corrupt pin rather than reading it as no pin, which would run the current code', () => {
    node('capture.mjs')
    writeFileSync(join(dir, 'r1.pin.json'), '{"resolved":')
    // A missing pin means the run finished and shed it; a corrupt one means nothing of the sort, and running live
    // there is the silent edit-under-a-live-actor the pin exists to remove.
    expect(() => readPin(dir, 'r1')).toThrow(/pin\.json.*corrupt.*Start a new run/s)
  })

  it('serves a wasm module back as the bytes it was loaded from', () => {
    // A load hook must hand wasm back as bytes, and a byte past 0x7f does not survive a trip through UTF-8, so a
    // catalog that imported wasm worked on its `create` and failed on every call after it.
    writeFileSync(join(dir, 'm.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x01, 0x78, 0xff, 0xfe]))
    write('entry.ts', "export { answer, namedGuard } from './dep.ts'\nimport './m.wasm'\n")
    // Unflagged from Node 24; the floor still needs the flag, which later versions accept and ignore.
    const flagged = (script: string) => execFileSync(process.execPath, ['--experimental-wasm-modules', '--no-warnings', join(dir, script)], { encoding: 'utf8', cwd: dir }).trim()
    const captured = JSON.parse(flagged('capture.mjs')) as { version: string }
    rmSync(join(dir, 'm.wasm'))
    expect(JSON.parse(flagged('serve.mjs'))).toMatchObject({ answer: 'ORIGINAL', version: captured.version })
  })
})
