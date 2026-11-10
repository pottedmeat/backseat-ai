/**
 * A spawn's `about` is the note its parent writes on one child, and it has to be evaluated at the spawn itself rather
 * than when the child is filed. A spawn is an entry action, and the `assign`s below it in the same list move context on
 * before the call reaches `fileChildren` — so an `about` reading `context.pending[0]` at filing time would label every
 * child with the *next* child's work (measured on xstate 5.32.6, pinned by a test). XState has nowhere to put it: it
 * drops options it does not know, and a persisted child is only `{snapshot, src, systemId, syncSnapshot}`.
 *
 * So the compiler lowers a `spawnChild` carrying `about` into the spawn followed by a note action, which resolves the
 * value against the context the spawn saw and leaves it here. `fileChildren` drains it later in the same call and puts
 * it on `Filed`, which is what persists. Nothing here outlives a call: it is a hand-off between two points in one.
 */
export type SpawnNote = { ref: unknown; src: string; about: unknown }

let notes: SpawnNote[] = []

/** Called by the note action the compiler inserts. `ref` is the spawning actor's own `self`, which is how two actors spawning the same `src` in one call stay apart. */
export function noteSpawn(ref: unknown, src: string, about: unknown): void {
  notes.push({ ref, src, about })
}

/** Drained by `fileChildren`, once, in the call that wrote them. */
export function takeSpawnNotes(): SpawnNote[] {
  const taken = notes
  notes = []
  return taken
}

/** Dropped at the top of every call, so a call that threw between the spawn and the filing cannot mislabel the next one's children. */
export function clearSpawnNotes(): void {
  notes = []
}
