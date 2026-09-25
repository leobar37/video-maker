/**
 * Driver argv contract of `demo:e2e` — pure parsing, no fs/network.
 *
 *   --spend-cap <usd>          hard cap journalled against every paid submit
 *                              (REQUIRED before any paid submit; the driver
 *                              refuses and prints planned costs without it)
 *   --mode <live|offline>      default `live`
 *   --project <dir>            default `projects/demo/hello`
 *   --allow-music-provider     opt-in to a PAID music generation when no
 *                              library bed is available (default: $0 reuse)
 */

export type E2eMode = 'live' | 'offline';

export interface E2eArgs {
  mode: E2eMode;
  project: string;
  /** Explicit operator cap; `undefined` when not provided (never guessed). */
  spendCapUsd: number | undefined;
  allowMusicProvider: boolean;
}

export class E2eUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eUsageError';
  }
}

export const E2E_USAGE =
  'usage: bun run demo:e2e -- [--spend-cap <usd>] [--mode <live|offline>] ' +
  '[--project <dir>] [--allow-music-provider]';

/** Parses and validates the driver argv. Throws `E2eUsageError` on anything else. */
export function parseE2eArgs(argv: readonly string[]): E2eArgs {
  const args: E2eArgs = {
    mode: 'live',
    project: 'projects/demo/hello',
    spendCapUsd: undefined,
    allowMusicProvider: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const takeValue = (): string => {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
        throw new E2eUsageError(`${E2E_USAGE}\nmissing value for ${name}`);
      }
      if (inlineValue === undefined) index += 1;
      return value;
    };
    switch (name) {
      case '--spend-cap': {
        const value = Number(takeValue());
        if (!Number.isFinite(value) || value < 0) {
          throw new E2eUsageError(`${E2E_USAGE}\n--spend-cap expects a non-negative number.`);
        }
        args.spendCapUsd = value;
        break;
      }
      case '--mode': {
        const value = takeValue();
        if (value !== 'live' && value !== 'offline') {
          throw new E2eUsageError(`${E2E_USAGE}\n--mode expects "live" or "offline".`);
        }
        args.mode = value;
        break;
      }
      case '--project': {
        const value = takeValue();
        if (value.trim().length === 0) {
          throw new E2eUsageError(`${E2E_USAGE}\n--project expects a non-empty directory.`);
        }
        args.project = value;
        break;
      }
      case '--allow-music-provider':
        args.allowMusicProvider = true;
        break;
      default:
        throw new E2eUsageError(`${E2E_USAGE}\nunknown argument ${name}`);
    }
  }
  return args;
}
