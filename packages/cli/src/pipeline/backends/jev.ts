/**
 * Jev backend — SEAM ONLY, future work.
 *
 * Jev is a decisions API over textual `state` (no vision): this module defines
 * the error and the factory so `--backend jev` has a stable landing spot, but
 * it intentionally contains NO API calls, NO key resolution, and NO logic.
 *
 * Planned mapping (documented here so the future implementation has a spec):
 * - `Score` → per-window relevance of a candidate clip window.
 * - `Choice` → clip form `single | duo` plus `keep | discard` per window.
 * - `Noul` → gates for `hook` / `closure` (window opens on a hook and ends on
 *   a complete sentence).
 * `JEV_API_KEY` would resolve env-first via `@videomaker/credentials` at call
 * time only — never at import time, and never in `mode: 'plan'`.
 */
import type { AgentRunner } from '../agent';

/** Thrown by {@link createJevAgentRunner} until the Jev backend ships. */
export class JevBackendNotImplementedError extends Error {
  constructor() {
    super(
      'Jev backend is future work; use --backend omp. ' +
        'See the Jev backend module docs for the planned Score/Choice/Noul mapping.',
    );
    this.name = 'JevBackendNotImplementedError';
  }
}

/**
 * Factory for the future Jev `AgentRunner`. Always throws
 * {@link JevBackendNotImplementedError} so callers get an actionable failure
 * instead of a silent fallback.
 */
export function createJevAgentRunner(): AgentRunner {
  throw new JevBackendNotImplementedError();
}
