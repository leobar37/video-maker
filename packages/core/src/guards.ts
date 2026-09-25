/**
 * Canonical runtime type guards for untrusted JSON boundaries. One guard per
 * concept lives here so validation code never reinvents narrowing locally.
 */

/** Narrow to an object with unknown fields; arrays and null are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
