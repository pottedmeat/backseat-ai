import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * **A definition cannot change under a live actor, because the run pins the code it started with.**
 *
 * The run's `create` call captures the machine's modules as it loads them; every later call serves them back, so an
 * edit, a delete or a rename mid-run has no effect until a new run.
 * `module.registerHooks()` does it with no dependency and no bundler.
 *
 * Both hooks are needed. `load` alone is never consulted for a file that no longer exists — resolution fails first
 * with `ERR_MODULE_NOT_FOUND` — so `resolve` short-circuits to the URL recorded at capture and `load` answers from
 * the captured bytes, and neither touches the disk.
 *
 * What the pin covers is **the modules loaded after it is registered**, which in the bin's own order is the authored
 * machine and what it pulls in: `backseat-ai` and its graph are already in the ESM cache by then, are never
 * offered to the hook, and the live copy wins silently. That is the decision, not an oversight — the definition
 * cannot change, and the runtime is not the definition.
 */

/**
 * The pin's file in the run directory, named for its root as the root's record and lock are. A pinned directory holds
 * several roots, each started on the code of its own `create`, so one pin per directory would serve them all the last.
 */
export const pinFile = (rootId: string) => `${rootId}.pin.json`

/** How many hex characters of the digest name a version: enough to be unique, short enough to read. */
const HASH_LENGTH = 12

/**
 * One module as the capturing call loaded it. `format` is what Node reported, which a CJS file reports as nothing.
 * Text is decoded as UTF-8, as Node decodes it; wasm is kept as base64, because Node takes it back only as bytes.
 */
export type PinnedModule = { format: string; source: string }

/**
 * The code one run started with. `resolved` is every specifier the capture resolved, keyed by the importer and the
 * text written, because a deleted file cannot be resolved again; `modules` is the bytes, keyed by URL.
 */
export type Pin = { resolved: Record<string, string>; modules: Record<string, PinnedModule> }

/** How this call relates to the pin: it is making one, running under one, or has no actor and needs neither. */
export type PinMode = 'capture' | 'serve' | 'off'

/** What the bin hands the CLI so the pin can be written once the run directory exists, and named on the record. */
export type PinSession = {
  /** The digest of the pinned code, which outlives the pin itself so a finished run still says what it ran. */
  version(): string | undefined
  /** Write the captured pin into a run directory for its root. Does nothing when serving: the pin is already there. */
  write(dir: string, rootId: string): void
  /**
   * Whether the pin holds this module. A module in the ESM cache before the hooks were registered is never offered to
   * them, so a capture that does not hold the catalog it just imported was beaten there by a static import.
   */
  has(url: string): boolean
}

const key = (parentURL: string | undefined, specifier: string) => `${parentURL ?? ''}\0${specifier}`

/** A module is keyed by the URL Node loaded it under, which for a file is its real path, not the path it was asked by. */
function canonical(url: string): string {
  if (!url.startsWith('file:')) return url
  try {
    return pathToFileURL(realpathSync(fileURLToPath(url))).href
  } catch {
    return url
  }
}

/** A digest over every module in the pin, by URL in sorted order so the same code always names itself the same. */
export function pinVersion(pin: Pin): string {
  const hash = createHash('sha256')
  for (const url of Object.keys(pin.modules).sort()) {
    const module_ = pin.modules[url]!
    hash.update(url).update('\0').update(module_.format).update('\0').update(module_.source).update('\0')
  }
  return hash.digest('hex').slice(0, HASH_LENGTH)
}

/** Which side of the pin a call is on, read from its command before anything is imported. */
export function pinModeOf(argv: string[]): { mode: PinMode; rootId?: string } {
  const [command, first] = argv
  if (command === 'create') return { mode: 'capture' }
  if (command === 'send' || command === 'snapshot' || command === 'describe') {
    if (first === undefined) return { mode: 'off' }
    // A child is addressed as `<root>/<child>`; the pin belongs to the root.
    return { mode: 'serve', rootId: first.split('/')[0] }
  }
  return { mode: 'off' }
}

export const pinPath = (dir: string, rootId: string) => join(dir, pinFile(rootId))

export function readPin(dir: string, rootId: string): Pin | undefined {
  const path = pinPath(dir, rootId)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Pin
  } catch {
    // No pin means the run finished and shed it. A corrupt one is not that, and running live would defeat the pin.
    throw new Error(`${path} is corrupt, so this run cannot run the code it started with. Start a new run.`)
  }
}

/** Shed a root's pin, keeping everything else the run wrote. Called when the root finishes: the log outlives the code. */
export function shedPin(dir: string, rootId: string): void {
  rmSync(pinPath(dir, rootId), { force: true })
}

/**
 * Record every module this process loads from here on. The capture is *unfiltered*: one snapshot write beats deciding
 * per module what might matter, and serving from memory is no slower than the disk it replaces.
 */
export function capturePin(): PinSession {
  const pin: Pin = { resolved: {}, modules: {} }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (typeof resolved.url === 'string') pin.resolved[key(context.parentURL, specifier)] = resolved.url
      return resolved
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (typeof loaded.source === 'string' || loaded.source instanceof Uint8Array) {
        const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString(loaded.format === 'wasm' ? 'base64' : 'utf8')
        // A CJS file reached by `require` from imported CJS reports no format at all, and handing that back to Node
        // throws ERR_UNKNOWN_MODULE_FORMAT, so it is named here rather than at the point it breaks.
        pin.modules[url] = { format: loaded.format ?? 'commonjs', source }
      }
      return loaded
    },
  })
  return {
    version: () => (Object.keys(pin.modules).length ? pinVersion(pin) : undefined),
    has: (url) => canonical(url) in pin.modules,
    write(dir, rootId) {
      if (!Object.keys(pin.modules).length) return
      mkdirSync(dir, { recursive: true })
      // Written through a rename so a concurrent reader never sees a torn pin.
      const path = pinPath(dir, rootId)
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(pin))
      renameSync(temporary, path)
    },
  }
}

class NotPinned extends Error {
  constructor(what: string) {
    super(
      `pinned run: ${what} is not in the run snapshot. This run pinned the code it started with, and that module was not among it — it is imported down a branch the run's first call never took. Start a new run to pick up the current code.`,
    )
    this.name = 'NotPinned'
  }
}

/**
 * Serve every import out of the pin, and **refuse** anything absent from it. Lenient fallback was measured and
 * rejected: a module imported down a branch the `create` call never took would silently run the edited code with no
 * error at all, which is the failure this whole mechanism exists to remove.
 */
export function servePin(pin: Pin): PinSession {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const recorded = pin.resolved[key(context.parentURL, specifier)]
      if (recorded !== undefined) return { url: recorded, shortCircuit: true }
      // The entry module is imported by URL and its importer differs between capture and serve, so it is matched on
      // the URL it already is rather than on who asked for it.
      if (specifier in pin.modules) return { url: specifier, shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      const pinned = pin.modules[url]
      if (pinned) return { format: pinned.format as never, source: pinned.format === 'wasm' ? Buffer.from(pinned.source, 'base64') : pinned.source, shortCircuit: true }
      // Not pinned and not already in the cache: this import is new since the run began.
      if (url.startsWith('node:') || url.startsWith('data:')) return nextLoad(url, context)
      throw new NotPinned(`'${url}'`)
    },
  })
  return { version: () => pinVersion(pin), write: () => {}, has: (url) => canonical(url) in pin.modules }
}

/** A call with no actor and nothing to pin: usage, the machine list, an error before any of it. */
export function noPin(): PinSession {
  return { version: () => undefined, write: () => {}, has: () => false }
}
