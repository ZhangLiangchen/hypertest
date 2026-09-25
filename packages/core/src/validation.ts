import { createRequire } from 'node:module';
import { HypertestError } from './errors.ts';
import { hashCanonical } from './json.ts';

/**
 * A plain JSON Schema (draft 2020-12) object. Schemas are data: they are sent to models as tool
 * parameter definitions and used for runtime validation.
 */
export type JsonSchema = { [key: string]: unknown };

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> = { valid: true; value: T } | { valid: false; issues: ValidationIssue[] };

interface AjvValidateFn {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string; params?: unknown }> | null;
}
interface AjvLike {
  compile(schema: JsonSchema): AjvValidateFn;
}

const require = createRequire(import.meta.url);
let ajvInstance: AjvLike | undefined;

function ajv(): AjvLike {
  if (!ajvInstance) {
    const AjvMod = require('ajv/dist/2020') as { default?: new (o: object) => AjvLike } & (new (o: object) => AjvLike);
    const Ajv2020 = (AjvMod.default ?? AjvMod) as new (o: object) => AjvLike;
    const formatsMod = require('ajv-formats') as { default?: (a: AjvLike) => void } & ((a: AjvLike) => void);
    const addFormats = (formatsMod.default ?? formatsMod) as (a: AjvLike) => void;
    ajvInstance = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

const cache = new Map<string, AjvValidateFn>();

/** Compiles (and caches by canonical hash) a JSON Schema into a validator. */
export function compileSchema<T = unknown>(schema: JsonSchema): (value: unknown) => ValidationResult<T> {
  const key = hashCanonical(schema);
  let fn = cache.get(key);
  if (!fn) {
    try {
      fn = ajv().compile(schema);
    } catch (e) {
      throw new HypertestError('invalid_argument', `invalid JSON schema: ${(e as Error).message}`, { cause: e });
    }
    cache.set(key, fn);
  }
  const validate = fn;
  return (value: unknown) => {
    if (validate(value)) return { valid: true, value: value as T };
    return {
      valid: false,
      issues: (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' })),
    };
  };
}

export function validateJson<T = unknown>(schema: JsonSchema, value: unknown): ValidationResult<T> {
  return compileSchema<T>(schema)(value);
}

/** Validates or throws `schema_violation` with the issue list in details. */
export function assertValid<T = unknown>(schema: JsonSchema, value: unknown, what = 'value'): T {
  const r = validateJson<T>(schema, value);
  if (!r.valid) {
    throw new HypertestError('schema_violation', `${what} does not match schema: ${r.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, {
      details: { issues: r.issues },
    });
  }
  return r.value;
}

/** Returns true when the schema itself compiles. */
export function isValidSchema(schema: unknown): schema is JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  try {
    compileSchema(schema as JsonSchema);
    return true;
  } catch {
    return false;
  }
}
