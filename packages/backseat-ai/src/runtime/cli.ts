import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileStore, withLock } from './file-store.js'
import { ID_SEPARATOR } from './registry.js'
import { scratchDir, setCurrentRun, shedScratch } from './run.js'
import { shedPin } from './pin.js'
import type { PinSession } from './pin.js'
import { createRuntime } from './runtime.js'
import { completeRun, pinnedLocator, runsDirs, runsLocator } from './runs.js'
import type { RunsDirs } from './runs.js'
import { appendTrace } from './trace.js'
import type { TraceEntry } from './trace.js'
import type { RuntimeOptions, ToolResponse } from './runtime.js'
import { render, renderError } from './render.js'
import type { Printable, Usage } from './render.js'

export type CliOptions = Omit<RuntimeOptions, 'store'> & {
  /** Name the usage text shows. Defaults to the running script's basename. */
  bin?: string
  /** Pin one directory as the run, for a harness. Defaults to `$BACKSEAT_STATE_DIR`; unset, each root gets its own run directory. */
  stateDir?: string
  /** Where unpinned runs live and where they go when finished. Defaults to the user's config, then the XDG state home and the OS temp dir. */
  runs?: RunsDirs
  /**
   * The pin this process registered before it imported the machines: capturing on `create`, serving on every later
   * call. The module hooks are already in place by the time this
   * is handed over; what is left is writing the capture once the run directory exists, and naming the version.
   */
  pin?: PinSession
}

/**
 * The agent-facing CLI: what a project's `cli.ts` runs under `--drive`.
 *
 * Lifecycle: nothing runs between invocations. Each invocation locks the root, rehydrates it from its file, acts, and
 * writes it back (ADR-0003). Exit code 0 on success, 2 when
 * the runtime rejected the event, 1 on any other error.
 *
 * Every invocation is appended to its run's `trace.jsonl` as the agent saw it (argv, actor, response, exit code); the
 * human bin's `report` renders that log as a page. A run is its root actor's directory, and the invocation that sees
 * the root finish moves the run from live to completed (ADR-0006).
 */
export function buildCli(options: CliOptions): { run(argv: string[]): Promise<void> } {
  const bin = options.bin ?? basename(process.argv[1] ?? 'cli').replace(/\.[cm]?[jt]s$/, '')
  const pinned = options.stateDir ?? process.env['BACKSEAT_STATE_DIR']
  const locate = pinned ? pinnedLocator(resolve(pinned)) : runsLocator(options.runs ?? runsDirs())
  const store = fileStore(locate.dirOf)
  /** A fresh runtime per use, so nothing cached in memory outlives the lock that made it current. */
  const runtime = (createId = options.createId ?? randomUUID) => createRuntime({ ...options, bin, store, createId, version: options.pin?.version() })
  const rootOf = (actorId: string) => actorId.split(ID_SEPARATOR)[0] ?? actorId
  /** The run a root is in, made current for whatever implementation asks */
  const enter = (rootId: string) => {
    const run = { id: rootId, dir: locate.dirOf(rootId) }
    setCurrentRun(run)
    return run
  }
  const locked = <T>(actorId: string, fn: () => Promise<T>) => {
    const dir = locate.dirOf(rootOf(actorId))
    return existsSync(dir) ? withLock(dir, rootOf(actorId), fn) : fn() // no run, nothing to lock: the store says unknown
  }

  const usage = () => {
    const commands: Record<string, { usage: string; description: string }> = {
      create: { usage: `${bin} create <machine>`, description: 'Start a fresh actor. The response is its id, its state, and the transitions enabled from there.' },
      send: { usage: `${bin} send <actorId> <event.type> ['<json payload>' | -]`, description: 'The only way to move an actor. Payload keys follow the schema shown for that event. A - in the payload\'s place reads the JSON from stdin instead.' },
      snapshot: { usage: `${bin} snapshot <actorId>`, description: 'Current state and enabled transitions, unchanged. How to orient when handed an id.' },
      describe: { usage: `${bin} describe <actorId> [<event.type>]`, description: 'With an event: that one move — where it leads, what it is for and its schema — and nothing else. Without one: the current state with its full first-arrival instructions, its data and its moves.' },
    }
    // The pre-actor surface only: what this tool fronts and how to start. How to read a response and how to drive
    // with one is the drive protocol, and it rides each actor's first presentation instead, because a subagent handed
    // a child never comes here.
    return { bin, machines: runtime().machines(), next: `${bin} create <machine>`, commands }
  }

  /**
   * What the driver reads. The object is stored separately (`printed`, below) and is what the trace records, so the
   * structured copy survives untouched while the printed bytes become text.
   */
  const print = (value: Printable, opts: { opening?: string } = {}) => process.stdout.write(render(value, { ...opts, bin }) + '\n')
  const fail = (error: unknown, extra: { usage?: Usage } = {}) => {
    const printed = { error: error instanceof Error ? error.message : String(error), ...extra }
    process.stderr.write(renderError(printed.error, extra.usage) + '\n')
    process.exitCode = 1
    return printed
  }
  const need = (value: string | undefined, what: string): string => {
    if (value === undefined) throw new UsageError(`missing <${what}>`)
    return value
  }

  /**
   * The payload of a `send`, as argv or — when it is `-` — read whole from stdin, so free text never passes through
   * the driver's shell. Read to completion before the
   * caller takes the lock, so a slow feed never holds the root; empty or unparseable stdin fails as any bad payload
   * does, loudly, on exit 1.
   */
  const payloadOf = async (given: string | undefined): Promise<Record<string, unknown>> => {
    if (given === undefined) return {}
    if (given !== '-') return JSON.parse(given) as Record<string, unknown>
    if (process.stdin.isTTY) throw new UsageError('payload - reads the payload from stdin, and stdin is a terminal')
    const chunks: Uint8Array[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array)
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }

  return {
    async run(argv) {
      const [command, ...rest] = argv
      const started = Date.now()
      let printed: unknown
      let actorId: string | undefined
      let moved: TraceEntry['moved']
      let warnings: TraceEntry['warnings']
      let effect: TraceEntry['effect']
      let payload: TraceEntry['payload']
      try {
        let response: unknown
        switch (command) {
          case undefined:
          case 'help':
          case '--help':
          case '-h':
            response = usage()
            break
          case 'create': {
            const name = need(rest[0], 'machine')
            if (!Object.hasOwn(options.machines, name)) throw new Error(`Unknown machine '${name}'`)
            // The run exists before the root takes its first step: an
            // entry action on the initial state may already be writing there.
            const id = (options.createId ?? randomUUID)()
            const run = enter(id)
            mkdirSync(run.dir, { recursive: true })
            // And so does its scratch directory, a sibling of the run rather than a part of it: what the machine
            // writes there, for another actor's driver to read, is never the record.
            mkdirSync(scratchDir(run.id), { recursive: true })
            // The run pins the code it started with, before the machine takes a step in it.
            options.pin?.write(run.dir, run.id)
            const traced = await runtime(() => id).createTraced(name)
            actorId = traced.response.actorId
            response = traced.response
            if (traced.moved.length) moved = traced.moved // the actor came into being: where it starts is on this call
            if (traced.warnings.length) warnings = traced.warnings
            break
          }
          case 'snapshot': {
            const id = (actorId = need(rest[0], 'actorId'))
            enter(rootOf(id))
            response = await locked(id, () => runtime().snapshot(id))
            break
          }
          case 'describe': {
            const id = (actorId = need(rest[0], 'actorId'))
            const type = rest[1]
            enter(rootOf(id))
            response = await locked(id, () => runtime().describe(id, type))
            break
          }
          case 'send': {
            const id = (actorId = need(rest[0], 'actorId'))
            const type = need(rest[1], 'event.type')
            payload = await payloadOf(rest[2])
            enter(rootOf(id))
            const traced = await locked(id, () => runtime().sendTraced(id, { ...payload, type }))
            response = traced.response
            if (traced.moved.length) moved = traced.moved
            if (traced.warnings.length) warnings = traced.warnings
            if (traced.effect) effect = traced.effect
            break
          }
          default:
            throw new UsageError(`unknown command '${command}'`)
        }
        // `create` is the one call that invents the id, so it says it; everywhere else the driver supplied it and the
        // footer is enough to confirm which actor answered.
        print(response as Printable, command === 'create' ? { opening: `Actor \`${actorId}\` is running \`${rest[0]}\`.` } : {})
        printed = response
        if ((response as ToolResponse & { rejected?: true }).rejected) process.exitCode = 2
      } catch (error) {
        printed = fail(error, error instanceof UsageError ? { usage: usage() } : {})
      }
      const entry: TraceEntry = { at: new Date(started).toISOString(), ms: Date.now() - started, pid: process.pid, argv, exitCode: (process.exitCode ?? 0) as 0 | 1 | 2, response: printed }
      if (actorId !== undefined) entry.actorId = actorId
      if (payload !== undefined) entry.payload = payload
      if (moved) entry.moved = moved
      if (warnings) entry.warnings = warnings
      if (effect) entry.effect = effect
      // A call on an actor lands in that actor's run; anything else — and a call on an actor no run holds — in the run-less file.
      const rootId = actorId === undefined ? undefined : rootOf(actorId)
      const runDir = rootId === undefined ? undefined : locate.dirOf(rootId)
      const record = rootId === undefined ? undefined : await store.get(rootId)
      const run = rootId !== undefined && runDir !== undefined && record ? { id: rootId, dir: runDir } : undefined
      await appendTrace(runDir !== undefined && existsSync(runDir) ? runDir : locate.dirOf(undefined), entry)
      if (run && record) {
        const status = record.snapshot.status
        const finished = status === 'done' || status === 'error'
        // The pin and the scratch directory are during-the-run artifacts and the log outlives the run: shed those,
        // keep this. A courier is meant to be lost, so nothing tries to preserve what was in scratch or list it.
        if (finished) {
          shedPin(run.dir, run.id)
          shedScratch(run.id)
        }
        if (finished && locate.runs && !locate.pinned) completeRun(locate.runs, run.id)
      }
    },
  }
}

class UsageError extends Error {}
