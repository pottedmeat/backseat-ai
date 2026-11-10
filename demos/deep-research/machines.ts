import { deepResearch } from './deep-research.ts'

/**
 * The catalog: what an agent may create, under the name it creates it by. `researchTask` is absent on purpose —
 * it is reached only by being spawned, and being missing from here is the whole of what keeps it out of the
 * catalog. It is still registered, because the lead's roster names it.
 */
export default { 'deep-research': deepResearch }
