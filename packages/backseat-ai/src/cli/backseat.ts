#!/usr/bin/env node
// The human bin, for what reads no catalog: the run store's commands, and `init`. What reads a project's machines runs through that project's own
// `cli.ts`, so no copy of Backseat here ever holds them (`agent.ts`).
await (await import('./human.js')).run(process.argv.slice(2))
