/**
 * Portal credential + origin discipline (contracts.md §7).
 *
 * - The API key comes ONLY from the injected env var `CUSTOMER_ASSETS_API_KEY`
 *   (never a CLI flag, never persisted, never echoed). It is resolved lazily
 *   at call time, so building a client or planning a command never touches it.
 * - `--origin` is mandatory and must be an explicit https origin (no path, no
 *   embedded credentials). Plain http is accepted ONLY for loopback hosts so
 *   tests and local development can target an ephemeral fake origin
 *   (gate G-cap-live: zero real network); every other origin must be https.
 */
import { StudioServiceError } from '@videomaker/studio';

import { CustomerAssetsClient } from '@videomaker/customer-assets/client';

/** Env var holding the agent API key (injected; never a flag). */
export const API_KEY_ENV = 'CUSTOMER_ASSETS_API_KEY';

/** Hosts where plain http is tolerated (local fake origins for tests/dev). */
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  '127.0.0.1': true,
  localhost: true,
  '::1': true,
  '[::1]': true,
};

function invalidOrigin(message: string): never {
  throw new StudioServiceError(
    'INVALID_INPUT',
    message,
    { flag: '--origin' },
  );
}

/**
 * Validates and normalizes an explicit portal origin. Returns `scheme://host[:port]`
 * with no path, query, userinfo or fragment. https is required everywhere
 * except loopback http (local fake origins only).
 */
export function parsePortalOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    invalidOrigin('--origin es obligatorio: pasá el origen https explícito del portal (sin path).');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    invalidOrigin('--origin no es una URL válida.');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    invalidOrigin('--origin no puede incluir credenciales (usuario/contraseña) en la URL.');
  }
  const isLoopback = LOOPBACK_HOSTS[url.hostname] === true;
  if (url.protocol === 'http:') {
    if (!isLoopback) {
      invalidOrigin('El origen debe ser https explícito; http solo se acepta en loopback (127.0.0.1/localhost/::1) para orígenes falsos locales.');
    }
  } else if (url.protocol !== 'https:') {
    invalidOrigin(`El origen debe ser https (recibido "${url.protocol}").`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    invalidOrigin('--origin debe ser un origen sin path (por ejemplo https://portal.example.com).');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    invalidOrigin('--origin no admite query ni fragment.');
  }
  return url.origin;
}

/** Reads the injected credential source; undefined when absent/empty. */
export function readApiKey(env: { readonly [key: string]: string | undefined } = process.env): string | undefined {
  const value = env[API_KEY_ENV];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Credential for real calls; AUTH_REQUIRED (operational) when not injected. */
export function requireApiKey(env: { readonly [key: string]: string | undefined } = process.env): string {
  const key = readApiKey(env);
  if (key === undefined) {
    throw new StudioServiceError(
      'AUTH_REQUIRED',
      `Falta la credencial del portal: inyectá ${API_KEY_ENV} en el entorno (nunca por flag ni archivo del proyecto).`,
      { env: API_KEY_ENV },
    );
  }
  return key;
}

/**
 * Builds the portal client for an approved origin. The credential is a
 * call-time resolver: constructing the client performs NO env lookup, and the
 * SDK attaches the header only to same-origin requests with redirect:'error'.
 */
export function createPortalClient(origin: string, env: { readonly [key: string]: string | undefined } = process.env): CustomerAssetsClient {
  return new CustomerAssetsClient({ baseUrl: origin, apiKey: () => readApiKey(env) });
}
