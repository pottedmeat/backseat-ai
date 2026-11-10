// `backseat-ai`: what a machine file imports. The compiler's surface, and the few runtime values a machine's own
// actions reach for — refusing an event, the run's scratch directory, the collection a gated transition hands over —
// so authoring a machine takes one import. The bin is `backseat-ai`, and a project's `cli.ts` imports
// `backseat-ai/cli`.
export * from './compiler/index.js'
export { currentRun, RejectedEvent, scratchDir } from './runtime/index.js'
export type { CollectedChild, Collection } from './runtime/index.js'
