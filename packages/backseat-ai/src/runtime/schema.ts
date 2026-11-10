import { z } from 'zod'

export type PayloadIssue = { path: string; message: string }

export type AnyObjectSchema = z.ZodObject<any>

export type SchemaMeta<TContext = any> = AnyObjectSchema | ((context: TContext) => AnyObjectSchema)

function isObjectSchema(value: unknown): value is AnyObjectSchema {
  return value instanceof z.ZodObject
}

/** A declared schema is a zod object schema or a function of context returning one (checked at resolution). */
export function isSchemaMeta(value: unknown): value is SchemaMeta {
  return isObjectSchema(value) || typeof value === 'function'
}

/** Apply a context-derived schema to the actor's current context; `where` names the declaration if it misbehaves. */
export function resolveSchema(schema: SchemaMeta | undefined, context: unknown, where: string): AnyObjectSchema | undefined {
  if (typeof schema !== 'function') return schema
  const resolved = schema(context)
  if (!isObjectSchema(resolved)) throw new Error(`meta.schema on ${where} must return a zod object schema`)
  return resolved
}

/** The contract for "send E to reach T" is T's schema extended by E's; either side optional. */
export function mergeSchemas(target?: AnyObjectSchema, transition?: AnyObjectSchema): AnyObjectSchema {
  if (target && transition) return target.extend(transition.shape)
  return target ?? transition ?? z.object({})
}

export function validatePayload(
  schema: AnyObjectSchema,
  payload: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: PayloadIssue[] } {
  const result = schema.safeParse(payload, { reportInput: true })
  if (result.success) return { ok: true, data: result.data as Record<string, unknown> }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      // A literal mismatch (a stale value against a context-derived schema) names what arrived beside what was expected.
      message: issue.code === 'invalid_value' && 'input' in issue ? `${issue.message}, received ${JSON.stringify(issue.input)}` : issue.message,
    })),
  }
}

/** Render a zod object schema as TypeScript type text, with constraints as trailing comments. */
export function renderSchema(schema: AnyObjectSchema): string {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  return printType(json, '')
}

type JsonSchema = {
  type?: string | string[]
  /** zod's `.describe()`, which `toJSONSchema` carries through. What a field is for, said on the field. */
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  additionalProperties?: JsonSchema | boolean
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  default?: unknown
  format?: string
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  minItems?: number
  maxItems?: number
}

function printType(schema: JsonSchema, indent: string): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) return variants.map((v) => printType(v, indent)).join(' | ')
  if (Array.isArray(schema.type)) {
    return schema.type.map((t) => printType({ ...schema, type: t }, indent)).join(' | ')
  }
  switch (schema.type) {
    case 'string':
    case 'boolean':
    case 'null':
      return schema.type
    case 'number':
    case 'integer':
      return 'number'
    case 'array': {
      const item = schema.items ? printType(schema.items, indent) : 'unknown'
      return item.includes(' | ') ? `Array<${item}>` : `${item}[]`
    }
    case 'object': {
      if (!schema.properties) {
        const extra = schema.additionalProperties
        return extra && typeof extra === 'object' ? `Record<string, ${printType(extra, indent)}>` : 'Record<string, unknown>'
      }
      const inner = indent + '  '
      const required = new Set(schema.required ?? [])
      const lines = Object.entries(schema.properties).map(([key, prop]) => {
        // A field's own `.describe()` leads; the machine-checkable constraints follow it in parentheses. Saying
        // why a field is wanted belongs here, on the field, and not in the instruction prose above the schema
        // (the style rule "do not say what the schema says").
        const notes = constraints(prop)
        const comment = prop.description ? (notes ? `${prop.description} (${notes})` : prop.description) : notes
        return `${inner}${key}${required.has(key) ? '' : '?'}: ${printType(prop, inner)}${comment ? ` // ${comment}` : ''}`
      })
      return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n${indent}}`
    }
    default:
      return 'unknown'
  }
}

function constraints(schema: JsonSchema): string {
  const notes: string[] = []
  if (schema.type === 'integer') notes.push('integer')
  if (schema.format) notes.push(schema.format)
  if (schema.pattern) notes.push(`matches /${schema.pattern}/`)
  const min = schema.minimum ?? schema.exclusiveMinimum
  const max = schema.maximum ?? schema.exclusiveMaximum
  if (min !== undefined && max !== undefined) notes.push(`${min}..${max}`)
  else if (min !== undefined) notes.push(`>= ${min}`)
  else if (max !== undefined) notes.push(`<= ${max}`)
  if (schema.minLength !== undefined) notes.push(`min length ${schema.minLength}`)
  if (schema.maxLength !== undefined) notes.push(`max length ${schema.maxLength}`)
  if (schema.minItems !== undefined) notes.push(`min ${schema.minItems} items`)
  if (schema.maxItems !== undefined) notes.push(`max ${schema.maxItems} items`)
  if (schema.items) {
    const itemNotes = constraints(schema.items)
    if (itemNotes) notes.push(`each: ${itemNotes}`)
  }
  if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`)
  return notes.join(', ')
}
