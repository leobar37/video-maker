/**
 * Default `StudioContext` factory: resolvable workspace root plus injectable
 * clock and id factory (tests inject deterministic ones).
 */
import path from 'node:path';

import type { StudioContext } from './contracts';
import { StudioServiceError } from './errors';

export interface StudioContextOverrides {
  clock?: () => Date;
  newId?: () => string;
}

function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, chars);
}

export function createStudioContext(workspaceDir: string, overrides: StudioContextOverrides = {}): StudioContext {
  if (typeof workspaceDir !== 'string' || workspaceDir.trim().length === 0) {
    throw new StudioServiceError('INVALID_INPUT', 'workspaceDir es obligatorio y no puede estar vacío.');
  }
  return {
    workspaceDir: path.resolve(workspaceDir),
    clock: overrides.clock ?? (() => new Date()),
    newId: overrides.newId ?? (() => `g-${randomHex(10)}`),
  };
}
