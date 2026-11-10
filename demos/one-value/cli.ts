// This project's front for its machines: `node cli.ts --drive` is the agent's tool, `node cli.ts` a person's.
// The catalog is named here and never imported, so a run can pin it before anything loads it.
import { cli } from 'backseat-ai/cli'

await cli(new URL('./machines.ts', import.meta.url))
