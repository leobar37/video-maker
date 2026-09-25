/**
 * Shared seam helpers for provider adapters.
 *
 * - `assertRunMode` is the NFR-002 hard stop: in `mode: 'plan'` no adapter may
 *   touch the network or resolve secrets.
 * - `EnvPresence` is the smoke-plan seam: name presence/absence only, so a
 *   plan can describe what would be required without ever reading a value.
 */
import type { Clock, ProviderContext } from '../ports';

export type { Clock, ProviderContext };

/** Thrown when an action is refused because the context is in plan mode. */
export class PlanModeError extends Error {
  constructor(action: string) {
    super(
      `${action} is refused in plan mode: plan/dry runs must stay offline and secret-free ` +
        '(NFR-002). Use the plan/validate surface instead.',
    );
    this.name = 'PlanModeError';
  }
}

/** Hard stop before any network call or secret resolution. */
export function assertRunMode(ctx: Pick<ProviderContext, 'mode'>, action: string): void {
  if (ctx.mode === 'plan') throw new PlanModeError(action);
}

/** Wall clock used when a context carries none. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Name-presence seam for configuration plans. Implementations answer whether a
 * NAME is declared; they must never expose the value itself.
 */
export type EnvPresence = (name: string) => boolean;

/** Presence backed by `process.env` (names only; values are never reported). */
export const processEnvPresence: EnvPresence = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
};
