import { lead } from './one-value.ts'

/**
 * The catalog: what an agent may create, under the names it creates them by. A project declares this record and the
 * bin imports it; nothing is discovered. `worker` is absent on purpose — it is reached only by being spawned, and
 * being missing from here is the whole of what keeps it out of the catalog.
 */
export default { 'one-value': lead }
