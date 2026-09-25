/**
 * SHA-256 helpers for content digests (FR-011).
 *
 * `sha256Json` hashes a canonical JSON encoding: object keys are sorted so the
 * digest is independent of key insertion order, and only strict JSON data is
 * accepted (no accessors, cycles, holes or non-finite numbers), so two equal
 * semantic inputs can never hash differently.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** The value is not strict JSON data (or contains a cycle). */
export class InvalidHashInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidHashInputError';
  }
}

/**
 * Canonical JSON text for stable digests: sorted object keys, arrays in order,
 * JSON-only values. Never silently omits, coerces or executes `toJSON`/getters.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object') {
      throw new InvalidHashInputError(
        `Canonical JSON only accepts finite JSON values; got ${typeof input}.`,
      );
    }
    if (ancestors.has(input)) {
      throw new InvalidHashInputError('Canonical JSON input contains a cycle.');
    }
    const array = Array.isArray(input);
    if (
      !array &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    ) {
      throw new InvalidHashInputError('Canonical JSON only accepts plain objects.');
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new InvalidHashInputError('Symbol keys are not JSON data.');
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new InvalidHashInputError('Accessors and hidden properties are not JSON data.');
      }
    }
    ancestors.add(input);
    try {
      if (array) {
        if (keys.length !== input.length + 1) {
          throw new InvalidHashInputError('Sparse arrays or extra properties are not JSON data.');
        }
        const parts: string[] = [];
        for (let i = 0; i < input.length; i++) {
          if (!Object.hasOwn(input, i)) {
            throw new InvalidHashInputError(`Array position ${i} is empty.`);
          }
          parts.push(encode(input[i]));
        }
        return `[${parts.join(',')}]`;
      }
      // `input` is a plain object with string keys (checked above).
      const record = input as Record<string, unknown>;
      // Same narrowing: symbol keys were rejected above.
      const stringKeys = keys as string[];
      return `{${stringKeys
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}

/** Lowercase hex SHA-256 of UTF-8 text or raw bytes. */
export function sha256Hex(buf: string | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Lowercase hex SHA-256 of a file's bytes. Streams the file so memory stays
 * bounded even for large renders. Rejects if the file cannot be read.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Uint8Array);
    }
  } catch (cause) {
    throw new InvalidHashInputError(`Could not hash file: ${path}`, { cause });
  }
  return hash.digest('hex');
}

/** Stable semantic digest: key order never changes the result. */
export function sha256Json(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
