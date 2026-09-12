import { z } from 'zod';

/**
 * Turns an MCP server's JSON Schema into the zod schema a tool needs.
 *
 * The alternative is to accept every call as `unknown` and let the server sort
 * it out. That would cost two things worth more than the conversion: the
 * worker would see a tool with no parameters in its MCP listing and have to
 * guess what to send, and a malformed call would fail at the vendor instead of
 * at the boundary, where the error can say which argument was wrong.
 *
 * It handles the subset MCP tools actually use - objects, strings, numbers,
 * booleans, arrays, enums, required lists - and falls back to "accept it" for
 * anything else rather than rejecting a tool it does not fully understand. An
 * unconverted corner of a schema means a slightly vaguer tool, never a missing
 * one.
 */
export function jsonSchemaToZod(schema: Readonly<Record<string, unknown>>): z.ZodTypeAny {
  return describe(schema, convert(schema));
}

function convert(schema: Readonly<Record<string, unknown>>): z.ZodTypeAny {
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const literals = enumValues.map((value) => z.literal(value as z.Primitive));
    return literals.length === 1
      ? (literals[0] as z.ZodTypeAny)
      : z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  // A union of types is more permissive than any one of them; take the loose
  // reading rather than guessing which member was meant.
  const type = schema['type'];
  if (Array.isArray(type)) return z.unknown();

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = asRecord(schema['items']);
      return z.array(items === null ? z.unknown() : jsonSchemaToZod(items));
    }
    case 'object':
      return objectSchema(schema);
    default:
      // No `type` but properties present is a common shorthand for an object.
      return schema['properties'] === undefined ? z.unknown() : objectSchema(schema);
  }
}

function objectSchema(schema: Readonly<Record<string, unknown>>): z.ZodTypeAny {
  const properties = asRecord(schema['properties']);
  if (properties === null) return z.record(z.unknown());

  const required = new Set(
    Array.isArray(schema['required']) ? schema['required'].filter((k): k is string => typeof k === 'string') : [],
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const child = asRecord(raw);
    const built = child === null ? z.unknown() : jsonSchemaToZod(child);
    shape[key] = required.has(key) ? built : built.optional();
  }

  // Passthrough, not strict: a server may accept arguments its published schema
  // does not mention, and refusing them here would be this layer inventing a
  // restriction the vendor never stated.
  return z.object(shape).passthrough();
}

function describe(schema: Readonly<Record<string, unknown>>, built: z.ZodTypeAny): z.ZodTypeAny {
  const description = schema['description'];
  return typeof description === 'string' && description.length > 0 ? built.describe(description) : built;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
