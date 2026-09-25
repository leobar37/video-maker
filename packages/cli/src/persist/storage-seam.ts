/**
 * ObjectStore seam for `archive` (FR-012).
 *
 * The persistence layer never constructs a concrete store or resolves
 * credentials itself (NFR-002): whoever wires the CLI provides a source that
 * returns an `ObjectStore` (the `@videomaker/providers` port) plus the
 * `ProviderContext` its calls require. Tests inject an in-memory fake; plan
 * mode never reaches this seam at all.
 */
import type { ObjectStore, ProviderContext } from '@videomaker/providers';

import { PersistError } from './errors';

/** A ready-to-use store adapter with the context its calls take. */
export interface ArchiveStorage {
  store: ObjectStore;
  /** Must be mode 'run': uploads are refused under a plan-mode context. */
  ctx: ProviderContext;
}

export type ArchiveStorageSource = () => ArchiveStorage | Promise<ArchiveStorage>;

let source: ArchiveStorageSource | null = null;

/** Installs (or with `null`, removes) the factory `run` uses for uploads. */
export function setArchiveStorageSource(next: ArchiveStorageSource | null): void {
  source = next;
}

/** Test hygiene: forget any installed factory. */
export function resetArchiveStorageSource(): void {
  source = null;
}

/**
 * Resolves the storage for a real `archive` run. Refuses without a configured
 * source — and refuses a plan-mode context even if one arrives (NFR-002).
 */
export async function resolveArchiveStorage(): Promise<ArchiveStorage> {
  if (!source) {
    throw new PersistError(
      'archive uploads need an ObjectStore but none is configured. Wire one at startup ' +
        '(setArchiveStorageSource, e.g. the R2 adapter) or stay in plan mode — planning never ' +
        'touches the store.',
    );
  }
  const storage = await source();
  if (storage.ctx.mode !== 'run') {
    throw new PersistError(
      'archive uploads are refused with a plan-mode ProviderContext (NFR-002): plan/dry runs ' +
        'must stay offline and secret-free.',
    );
  }
  return storage;
}
