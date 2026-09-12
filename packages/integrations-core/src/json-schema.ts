import { z } from 'zod';

/**
 * Converts the subset of zod used by tool schemas into JSON Schema.
 *
 * Tools are authored in zod because the broker has to *validate* untrusted
 * agent input, and a JSON Schema validator is another dependency for a job zod
 * already does. But MCP and `ToolDescriptor` speak JSON Schema, so the two
 * representations must agree - deriving one from the other is the only way they
 * stay in agreement as tools change.
 *
 * The supported subset is deliberately small: objects of scalars, enums,
 * arrays, unions of literals, and the optional/default/nullable wrappers. A
 * tool needing more than that is almost certainly taking input an agent should
 * not be composing freehand.
 */
export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const body = convert(schema);
  return schema.description ? { ...body, description: schema.description } : body;
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return describe(schema, convert(schema.unwrap() as z.ZodTypeAny));
  }
  if (schema instanceof z.ZodDefault) {
    const inner = schema._def.innerType as z.ZodTypeAny;
    return describe(schema, { ...convert(inner), default: schema._def.defaultValue() });
  }
  if (schema instanceof z.ZodEffects) {
    return describe(schema, convert(schema.innerType() as z.ZodTypeAny));
  }
  if (schema instanceof z.ZodObject) {
    return describe(schema, objectSchema(schema));
  }
  if (schema instanceof z.ZodArray) {
    return describe(schema, { type: 'array', items: toJsonSchema(schema.element as z.ZodTypeAny) });
  }
  if (schema instanceof z.ZodEnum) {
    return describe(schema, { type: 'string', enum: [...(schema.options as readonly string[])] });
  }
  if (schema instanceof z.ZodLiteral) {
    return describe(schema, { const: schema.value });
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as readonly z.ZodTypeAny[];
    return describe(schema, { anyOf: options.map((o) => toJsonSchema(o)) });
  }
  if (schema instanceof z.ZodString) return describe(schema, { type: 'string' });
  if (schema instanceof z.ZodNumber) {
    return describe(schema, { type: schema.isInt ? 'integer' : 'number' });
  }
  if (schema instanceof z.ZodBoolean) return describe(schema, { type: 'boolean' });
  if (schema instanceof z.ZodRecord) {
    return describe(schema, {
      type: 'object',
      additionalProperties: toJsonSchema(schema.valueSchema as z.ZodTypeAny),
    });
  }
  // ZodAny / ZodUnknown / anything unmodelled: an unconstrained value is the
  // honest translation. Validation still happens against the zod schema.
  return {};
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = toJsonSchema(value);
    if (!value.isOptional()) required.push(key);
  }
  const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) out['required'] = required;
  return out;
}

function describe(schema: z.ZodTypeAny, body: JsonSchema): JsonSchema {
  return schema.description ? { ...body, description: schema.description } : body;
}
