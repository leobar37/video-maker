/**
 * Backend registry for the `AgentRunner` seam. `--backend omp|jev` selects the
 * factory here; the runner itself is transport-only and returns RAW model text.
 */
import type { AgentRunner } from '../agent';

import { createJevAgentRunner } from './jev';
import { createOmpAgentRunner, type OmpRunnerOptions } from './omp-sdk';

export type { OmpRunnerOptions } from './omp-sdk';

export const BACKEND_IDS = ['omp', 'jev'] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

/** Builds the selected backend; `'jev'` throws until that backend ships. */
export function createAgentRunner(backend: BackendId, options: OmpRunnerOptions): AgentRunner {
  if (backend === 'omp') {
    return createOmpAgentRunner(options);
  }
  return createJevAgentRunner();
}
