/**
 * JSON document IO for the file-based workspace: strict reads (NOT_FOUND /
 * INVALID_INPUT) and exclusive-create writes (CONFLICT, never overwrite a
 * sealed or already-present document). Parsing stays schema-driven without
 * importing zod directly — `@videomaker/schemas` is the only contract source.
 */
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { StudioIdSchema } from '@videomaker/schemas';

import { fail } from './errors';

/** Structural slice of a zod schema, so studio never depends on zod itself. */
export interface SafeParseable<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number | symbol>; message: string }> } };
}

const MAX_ISSUES_IN_DETAILS = 10;

function summarizeIssues(issues: Array<{ path: Array<string | number | symbol>; message: string }>): Array<Record<string, unknown>> {
  return issues.slice(0, MAX_ISSUES_IN_DETAILS).map((issue, index) => ({
    index,
    at: issue.path.map(String).join('.') || '(raíz)',
    message: issue.message,
  }));
}

export async function readJsonDocument<T>(absPath: string, schema: SafeParseable<T>, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (cause) {
    fail('NOT_FOUND', `${label} no existe.`, { file: path.basename(absPath) }, cause);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (cause) {
    fail('INVALID_INPUT', `${label} no es JSON válido.`, { file: path.basename(absPath) }, cause);
  }
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    fail('INVALID_INPUT', `${label} viola el contrato de datos.`, { issues: summarizeIssues(result.error.issues) });
  }
  return result.data;
}

/** Validate an in-memory document before it is persisted or embedded. */
export function parseOrInvalid<T>(schema: SafeParseable<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail('INVALID_INPUT', `${label} viola el contrato de datos.`, { issues: summarizeIssues(result.error.issues) });
  }
  return result.data;
}

export async function writeExclusiveJson(absPath: string, value: unknown, label: string): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(absPath, 'wx');
  } catch (cause) {
    fail('CONFLICT', `${label} ya existe; la operación nunca sobrescribe.`, { file: path.basename(absPath) }, cause);
  }
  try {
    await handle.writeFile(serialized, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Write raw bytes creating parent directories; used for staged seal copies. */
export async function writeBytesFile(absPath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, bytes);
}

/** Kebab-case entity id gate shared by every service input. */
export function assertStudioId(value: string, label: string): string {
  const result = StudioIdSchema.safeParse(value);
  if (!result.success) {
    fail('INVALID_INPUT', `${label} debe ser un id kebab-case válido.`, { field: label, value: String(value).slice(0, 40) });
  }
  return value;
}

export function assertNonEmptyString(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_INPUT', `${label} es obligatorio y no puede estar vacío.`, { field: label });
  }
  return value;
}
