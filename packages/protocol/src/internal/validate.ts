/**
 * Tiny hand-rolled runtime validation combinators (internal, not re-exported).
 *
 * A {@link Check} returns `null` when the value is valid, or a human-readable
 * error string prefixed with the JSON path of the offending value. Checks never
 * throw. Unknown extra object keys are allowed (forward compatibility).
 */

/** Result of validating an unknown value against a protocol schema. */
export type ValidationResult = { ok: true } | { ok: false; error: string };

/** A validator: `null` when valid, otherwise an error message with a path. */
export type Check = (value: unknown, path: string) => string | null;

/** Maximum nesting depth accepted for arbitrary JSON payloads. */
const MAX_JSON_DEPTH = 64;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return typeof value;
}

function fail(path: string, expected: string, value: unknown): string {
  return `${path}: expected ${expected}, got ${describe(value)}`;
}

export const string: Check = (v, p) => (typeof v === 'string' ? null : fail(p, 'string', v));

export const nonEmptyString: Check = (v, p) =>
  typeof v === 'string' && v.length > 0 ? null : fail(p, 'non-empty string', v);

export const boolean: Check = (v, p) => (typeof v === 'boolean' ? null : fail(p, 'boolean', v));

/** Finite number (rejects NaN and +/-Infinity). */
export const number: Check = (v, p) =>
  typeof v === 'number' && Number.isFinite(v) ? null : fail(p, 'finite number', v);

export const integer: Check = (v, p) => (Number.isInteger(v) ? null : fail(p, 'integer', v));

/** Finite number within `[min, max]` (inclusive). */
export function range(min: number, max: number): Check {
  return (v, p) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
      ? null
      : fail(p, `number in [${min}, ${max}]`, v);
}

export const nonNegativeNumber: Check = range(0, Number.MAX_VALUE);

export const positiveNumber: Check = (v, p) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? null : fail(p, 'positive number', v);

export const nonNegativeInteger: Check = (v, p) =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? null : fail(p, 'non-negative integer', v);

/** 24-bit RGB color as a number (0x000000..0xFFFFFF). */
export const hexColorNumber: Check = (v, p) =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffff
    ? null
    : fail(p, 'integer color in [0x000000, 0xFFFFFF]', v);

/** One of a fixed set of string literals. */
export function oneOf(values: readonly string[]): Check {
  return (v, p) =>
    typeof v === 'string' && values.includes(v)
      ? null
      : `${p}: expected one of ${values.map((x) => JSON.stringify(x)).join(' | ')}, got ${
          typeof v === 'string' ? JSON.stringify(v) : describe(v)
        }`;
}

export function literal(value: string | number | boolean): Check {
  return (v, p) => (v === value ? null : `${p}: expected ${JSON.stringify(value)}`);
}

export function array(item: Check, opts: { min?: number } = {}): Check {
  return (v, p) => {
    if (!Array.isArray(v)) return fail(p, 'array', v);
    if (opts.min !== undefined && v.length < opts.min) {
      return `${p}: expected at least ${opts.min} item(s), got ${v.length}`;
    }
    for (let i = 0; i < v.length; i++) {
      const err = item(v[i], `${p}[${i}]`);
      if (err) return err;
    }
    return null;
  };
}

/** Fixed-length array with a check per position. */
export function tuple(...items: Check[]): Check {
  return (v, p) => {
    if (!Array.isArray(v)) return fail(p, `array of length ${items.length}`, v);
    if (v.length !== items.length) {
      return `${p}: expected array of length ${items.length}, got length ${v.length}`;
    }
    for (let i = 0; i < items.length; i++) {
      const err = items[i]!(v[i], `${p}[${i}]`);
      if (err) return err;
    }
    return null;
  };
}

/**
 * Plain object with required and optional keys. A key whose value is
 * `undefined` counts as absent. Extra keys are ignored.
 */
export function object(
  required: Record<string, Check>,
  optional: Record<string, Check> = {},
): Check {
  return (v, p) => {
    if (!isRecord(v)) return fail(p, 'object', v);
    for (const key of Object.keys(required)) {
      const value = v[key];
      if (value === undefined) return `${p}.${key}: required field is missing`;
      const err = required[key]!(value, `${p}.${key}`);
      if (err) return err;
    }
    for (const key of Object.keys(optional)) {
      const value = v[key];
      if (value === undefined) continue;
      const err = optional[key]!(value, `${p}.${key}`);
      if (err) return err;
    }
    return null;
  };
}

export function nullable(check: Check): Check {
  return (v, p) => (v === null ? null : check(v, p));
}

/** Passes when any of the checks passes; reports the last failure otherwise. */
export function anyOf(...checks: Check[]): Check {
  return (v, p) => {
    let last: string | null = `${p}: no alternatives`;
    for (const check of checks) {
      last = check(v, p);
      if (last === null) return null;
    }
    return last;
  };
}

/** Object used as a string-keyed dictionary whose values all pass `value`. */
export function record(value: Check): Check {
  return (v, p) => {
    if (!isRecord(v)) return fail(p, 'object', v);
    for (const key of Object.keys(v)) {
      const err = value(v[key], `${p}[${JSON.stringify(key)}]`);
      if (err) return err;
    }
    return null;
  };
}

/**
 * Discriminated union on a string tag key (e.g. `type` or `kind`). Unknown tags
 * are rejected.
 */
export function discriminated(key: string, variants: Record<string, Check>): Check {
  const known = Object.keys(variants);
  return (v, p) => {
    if (!isRecord(v)) return fail(p, 'object', v);
    const tag = v[key];
    if (typeof tag !== 'string') return fail(`${p}.${key}`, 'string', tag);
    const variant = Object.prototype.hasOwnProperty.call(variants, tag) ? variants[tag] : undefined;
    if (!variant) {
      return `${p}.${key}: unknown ${key} ${JSON.stringify(tag)} (expected one of ${known
        .map((x) => JSON.stringify(x))
        .join(' | ')})`;
    }
    return variant(v, p);
  };
}

/** Any JSON-serialisable value (finite numbers only, bounded depth). */
export const json: Check = (v, p) => jsonAt(v, p, 0);

function jsonAt(v: unknown, p: string, depth: number): string | null {
  if (depth > MAX_JSON_DEPTH) return `${p}: JSON value nested deeper than ${MAX_JSON_DEPTH}`;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : fail(p, 'finite number', v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const err = jsonAt(v[i], `${p}[${i}]`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (isRecord(v)) {
    for (const key of Object.keys(v)) {
      const err = jsonAt(v[key], `${p}[${JSON.stringify(key)}]`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  return fail(p, 'JSON value', v);
}

/** Runs a check without ever throwing and converts it to a {@link ValidationResult}. */
export function run(check: Check, value: unknown, path = '$'): ValidationResult {
  try {
    const error = check(value, path);
    return error === null ? { ok: true } : { ok: false, error };
  } catch (e) {
    return { ok: false, error: `${path}: validation failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
