/**
 * Planned-cost model and spend-cap enforcement for the e2e driver (pure).
 *
 * The driver NEVER spends without an explicit operator cap: it prints the
 * planned costs first, refuses paid submits without `--spend-cap`, refuses
 * when the plan (or the journalled cumulative spend) would exceed the cap,
 * and leaves the enforced limit to the core paid-operation engine at submit
 * time. Estimates mirror the CLI spec's planning numbers (reservations, not
 * price quotes).
 */

/** Planning estimate of one TTS synthesis (reservation, not a price quote). */
export const TTS_PLANNED_USD_PER_1K_CHARS = 0.3;

/** Planning estimate of one paid music generation. */
export const MUSIC_PLANNED_USD_PER_TRACK = 0.5;

/** Where the music bed comes from — and what it may cost. */
export type MusicSourceDecision =
  | { kind: 'reuse'; bedRef: string; estimatedCostUsd: 0; detail: string }
  | {
      kind: 'generate';
      provider: 'elevenlabs' | 'fal';
      estimatedCostUsd: number;
      detail: string;
    }
  | { kind: 'skip'; estimatedCostUsd: 0; detail: string };

export interface MusicSourceInput {
  /** Bed ids/names available in the music library (already $0). */
  libraryBeds: readonly string[];
  allowMusicProvider: boolean;
  /** Remaining cap headroom in USD (cap minus journalled spend). */
  spendCapHeadroomUsd: number;
  /** Preferred bed when several are registered. */
  preferredBed?: string;
}

/**
 * Library reuse first (always $0); a PAID generation only when the library
 * has no bed AND the operator passed `--allow-music-provider` AND the cap has
 * headroom for it. Otherwise the bed is skipped and documented.
 */
export function decideMusicSource(input: MusicSourceInput): MusicSourceDecision {
  const bed =
    input.preferredBed !== undefined && input.libraryBeds.includes(input.preferredBed)
      ? input.preferredBed
      : input.libraryBeds[0];
  if (bed !== undefined) {
    return {
      kind: 'reuse',
      bedRef: bed,
      estimatedCostUsd: 0,
      detail: `reuse library bed "${bed}" ($0; no submit, no receipt needed)`,
    };
  }
  if (input.allowMusicProvider) {
    if (input.spendCapHeadroomUsd >= MUSIC_PLANNED_USD_PER_TRACK) {
      return {
        kind: 'generate',
        provider: 'elevenlabs',
        estimatedCostUsd: MUSIC_PLANNED_USD_PER_TRACK,
        detail:
          'no library bed; paid generation opted in with cap headroom ' +
          `(est. $${MUSIC_PLANNED_USD_PER_TRACK.toFixed(2)})`,
      };
    }
    return {
      kind: 'skip',
      estimatedCostUsd: 0,
      detail:
        'no library bed and the spend cap has no headroom for a paid generation ' +
        `($${MUSIC_PLANNED_USD_PER_TRACK.toFixed(2)} needed); bed skipped, ducking stage will be documented as skipped`,
    };
  }
  return {
    kind: 'skip',
    estimatedCostUsd: 0,
    detail:
      'no library bed; paid generation not allowed (pass --allow-music-provider to opt in) — ' +
      'bed skipped, ducking stage will be documented as skipped',
  };
}

export interface PlannedOperation {
  command: string;
  subject: string;
  detail: string;
  /** USD this operation may reserve if it really submits. */
  estimatedCostUsd: number;
  /** True when the operation may perform a PAID submit. */
  paid: boolean;
}

export interface SpendPlan {
  operations: PlannedOperation[];
  /** Sum of the paid estimates (what the cap must cover worst-case). */
  paidTotalUsd: number;
}

export interface SpendPlanInput {
  mode: 'live' | 'offline';
  narrationChars: number;
  /**
   * True when the narration master must be really submitted (no verified
   * master to replay). A replay is always $0.
   */
  narrationWillSubmit: boolean;
  music: MusicSourceDecision;
}

/** Builds the full cost plan of one e2e run (all stages, paid or not). */
export function buildSpendPlan(input: SpendPlanInput): SpendPlan {
  const paidNarration = input.mode === 'live' && input.narrationWillSubmit;
  const narrationEstimate = paidNarration
    ? Math.round(((input.narrationChars / 1000) * TTS_PLANNED_USD_PER_1K_CHARS) * 1e4) / 1e4
    : 0;
  const operations: PlannedOperation[] = [
    {
      command: 'gen-audio',
      subject: 'narration master',
      detail:
        input.mode === 'offline'
          ? 'offline synth narration master ($0; journalled with an offline receipt)'
          : paidNarration
            ? `one continuous TTS synthesis (${input.narrationChars} chars; submit-once)`
            : 'verified narration master replayed ($0; no submit)',
      estimatedCostUsd: narrationEstimate,
      paid: paidNarration,
    },
    {
      command: 'gen-music',
      subject: input.music.kind === 'reuse' ? input.music.bedRef : 'music bed',
      detail: input.music.detail,
      estimatedCostUsd: input.music.estimatedCostUsd,
      paid: input.music.kind === 'generate',
    },
    {
      command: 'assemble',
      subject: 'render + ducking + loudnorm',
      detail: 'local render and audio stages (no paid submit)',
      estimatedCostUsd: 0,
      paid: false,
    },
    {
      command: 'qa',
      subject: 'evidence verification',
      detail: 'hash + loudness verification (no paid submit)',
      estimatedCostUsd: 0,
      paid: false,
    },
    {
      command: 'publish --dry-run',
      subject: 'publication plan',
      detail: 'plan mode only: no publisher call, no spend (NFR-002)',
      estimatedCostUsd: 0,
      paid: false,
    },
  ];
  return {
    operations,
    paidTotalUsd:
      Math.round(operations.reduce((sum, op) => sum + (op.paid ? op.estimatedCostUsd : 0), 0) * 1e4) /
      1e4,
  };
}

/** Thrown when the run must refuse to spend (no cap, or cap would be exceeded). */
export class SpendCapRefusal extends Error {
  constructor(message: string, readonly plan: SpendPlan) {
    super(message);
    this.name = 'SpendCapRefusal';
  }
}

/**
 * Pre-submit gate: paid operations REQUIRE an explicit cap, and the plan's
 * paid total must fit inside it. $0 runs never need a cap.
 */
export function enforceSpendCap(plan: SpendPlan, spendCapUsd: number | undefined): void {
  if (plan.paidTotalUsd <= 0) return;
  if (spendCapUsd === undefined) {
    throw new SpendCapRefusal(
      'refusing paid operations without an explicit cap: rerun with ' +
        `--spend-cap <usd> (planned paid total $${plan.paidTotalUsd.toFixed(4)}).`,
      plan,
    );
  }
  if (plan.paidTotalUsd > spendCapUsd) {
    throw new SpendCapRefusal(
      `planned paid total $${plan.paidTotalUsd.toFixed(4)} exceeds the spend cap ` +
        `$${spendCapUsd.toFixed(4)}; raise --spend-cap or drop the paid operations.`,
      plan,
    );
  }
}

/**
 * Per-submit gate: cumulative journalled spend PLUS the next reservation must
 * fit the cap (checked before every paid submit, mirroring the spend ledger's
 * own per-plan enforcement at run level).
 */
export function assertSpendHeadroom(
  journalledUsd: number,
  nextUsd: number,
  spendCapUsd: number | undefined,
): void {
  if (nextUsd <= 0) return;
  if (spendCapUsd === undefined) {
    throw new SpendCapRefusal(
      `refusing a paid submit of $${nextUsd.toFixed(4)} without an explicit --spend-cap.`,
      { operations: [], paidTotalUsd: nextUsd },
    );
  }
  if (journalledUsd + nextUsd > spendCapUsd) {
    throw new SpendCapRefusal(
      `spend cap $${spendCapUsd.toFixed(4)} would be exceeded: journalled ` +
        `$${journalledUsd.toFixed(4)} + this submit $${nextUsd.toFixed(4)}.`,
      { operations: [], paidTotalUsd: nextUsd },
    );
  }
}

/** Printable planned-cost table (no secrets; used before any submit). */
export function formatCostTable(plan: SpendPlan, spendCapUsd: number | undefined): string[] {
  const lines = ['planned costs (estimates; the cap is the hard limit):'];
  for (const op of plan.operations) {
    const mark = op.paid ? 'PAID ' : 'free ';
    lines.push(`  ${mark} ${op.command.padEnd(18)} $${op.estimatedCostUsd.toFixed(4)}  ${op.detail}`);
  }
  lines.push(
    `  planned paid total $${plan.paidTotalUsd.toFixed(4)} / cap ` +
      (spendCapUsd === undefined ? 'UNSET (pass --spend-cap for paid runs)' : `$${spendCapUsd.toFixed(4)}`),
  );
  return lines;
}
