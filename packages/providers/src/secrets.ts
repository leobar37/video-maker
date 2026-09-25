/**
 * `createSecretSource`: adapts `@videomaker/credentials` to the `SecretSource`
 * port — the only door from the provider adapters to credential resolution.
 *
 * Plan-mode refusal is preserved: `resolveCredentials` hard-refuses `mode:
 * 'plan'` before touching the environment, `.env`, Doppler or the network
 * (NFR-002). Secret values travel only into provider request headers and are
 * reported here exclusively as `redact()` presence summaries (NFR-001).
 */
import {
  ALL_SECRET_NAMES,
  redact,
  resolveCredentials,
  type Mode,
  type SecretName,
} from '@videomaker/credentials';

import type { FetchLike, SecretSource } from './ports';

export interface CreateSecretSourceOptions {
  /** Test seam forwarded to credential resolution. */
  fetchImpl?: FetchLike;
  /** Receives redacted presence reports only — never secret values. */
  logger?: (msg: string) => void;
}

function isSecretName(name: string): name is SecretName {
  const known: readonly string[] = ALL_SECRET_NAMES;
  return known.includes(name);
}

export function createSecretSource(options: CreateSecretSourceOptions = {}): SecretSource {
  return {
    async getSecret(name: string, mode: Mode): Promise<string> {
      if (!isSecretName(name)) {
        throw new Error(
          `Unknown secret name ${name}; known names: ${ALL_SECRET_NAMES.join(', ')}.`,
        );
      }
      // resolveCredentials refuses plan mode before touching anything, so a
      // plan/dry run can never resolve or fetch a secret (NFR-002).
      const value = await resolveCredentials(name, {
        mode,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      options.logger?.(`secret resolved: ${redact(value, name)}`);
      return value;
    },
  };
}
