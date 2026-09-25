/**
 * Spend-cap enforcement: paid operations REQUIRE an explicit cap, the plan
 * must fit it, and the per-submit cumulative check refuses anything that
 * would exceed it — the invariants that keep a demo run from overspending.
 */
import { describe, expect, test } from 'bun:test';

import {
  MUSIC_PLANNED_USD_PER_TRACK,
  SpendCapRefusal,
  assertSpendHeadroom,
  buildSpendPlan,
  decideMusicSource,
  enforceSpendCap,
  formatCostTable,
} from './costs';

const OFFLINE_MUSIC = decideMusicSource({
  libraryBeds: ['demo-soft-pad'],
  allowMusicProvider: false,
  spendCapHeadroomUsd: 10,
});

describe('decideMusicSource', () => {
  test('library reuse first, always $0', () => {
    const decision = decideMusicSource({
      libraryBeds: ['demo-soft-pad', 'other'],
      allowMusicProvider: true,
      spendCapHeadroomUsd: 10,
      preferredBed: 'demo-soft-pad',
    });
    expect(decision.kind).toBe('reuse');
    expect(decision.estimatedCostUsd).toBe(0);
  });

  test('paid generation only with the flag AND cap headroom', () => {
    const paid = decideMusicSource({
      libraryBeds: [],
      allowMusicProvider: true,
      spendCapHeadroomUsd: MUSIC_PLANNED_USD_PER_TRACK,
    });
    expect(paid.kind).toBe('generate');
    expect(paid.estimatedCostUsd).toBe(MUSIC_PLANNED_USD_PER_TRACK);

    const withoutFlag = decideMusicSource({
      libraryBeds: [],
      allowMusicProvider: false,
      spendCapHeadroomUsd: 10,
    });
    expect(withoutFlag.kind).toBe('skip');

    const withoutHeadroom = decideMusicSource({
      libraryBeds: [],
      allowMusicProvider: true,
      spendCapHeadroomUsd: MUSIC_PLANNED_USD_PER_TRACK - 0.01,
    });
    expect(withoutHeadroom.kind).toBe('skip');
  });
});

describe('buildSpendPlan', () => {
  test('live submits reserve the TTS estimate; offline is $0', () => {
    const live = buildSpendPlan({
      mode: 'live',
      narrationChars: 1000,
      narrationWillSubmit: true,
      music: OFFLINE_MUSIC,
    });
    expect(live.paidTotalUsd).toBeCloseTo(0.3, 6);
    expect(live.operations.map((operation) => operation.command)).toEqual([
      'gen-audio',
      'gen-music',
      'assemble',
      'qa',
      'publish --dry-run',
    ]);

    const offline = buildSpendPlan({
      mode: 'offline',
      narrationChars: 1000,
      narrationWillSubmit: true,
      music: OFFLINE_MUSIC,
    });
    expect(offline.paidTotalUsd).toBe(0);
  });

  test('a replayed master costs nothing', () => {
    const replay = buildSpendPlan({
      mode: 'live',
      narrationChars: 1000,
      narrationWillSubmit: false,
      music: OFFLINE_MUSIC,
    });
    expect(replay.paidTotalUsd).toBe(0);
  });
});

describe('enforceSpendCap', () => {
  test('refuses paid operations without an explicit cap', () => {
    const plan = buildSpendPlan({
      mode: 'live',
      narrationChars: 1000,
      narrationWillSubmit: true,
      music: OFFLINE_MUSIC,
    });
    expect(() => enforceSpendCap(plan, undefined)).toThrow(SpendCapRefusal);
    expect(() => enforceSpendCap(plan, undefined)).toThrow('--spend-cap');
    expect(() => enforceSpendCap(plan, 1)).not.toThrow();
  });

  test('refuses when the plan would exceed the cap', () => {
    const plan = buildSpendPlan({
      mode: 'live',
      narrationChars: 1000,
      narrationWillSubmit: true,
      music: OFFLINE_MUSIC,
    });
    expect(() => enforceSpendCap(plan, 0.1)).toThrow(SpendCapRefusal);
    expect(() => enforceSpendCap(plan, 0.1)).toThrow('exceeds the spend cap');
  });

  test('$0 runs never need a cap', () => {
    const plan = buildSpendPlan({
      mode: 'offline',
      narrationChars: 1000,
      narrationWillSubmit: true,
      music: OFFLINE_MUSIC,
    });
    expect(() => enforceSpendCap(plan, undefined)).not.toThrow();
  });
});

describe('assertSpendHeadroom', () => {
  test('refuses a paid submit without a cap and when cumulative spend would exceed it', () => {
    expect(() => assertSpendHeadroom(0, 0.3, undefined)).toThrow(SpendCapRefusal);
    expect(() => assertSpendHeadroom(0.25, 0.3, 0.5)).toThrow('would be exceeded');
    expect(() => assertSpendHeadroom(0.2, 0.3, 0.5)).not.toThrow();
    expect(() => assertSpendHeadroom(5, 0, 0.5)).not.toThrow();
  });
});

describe('formatCostTable', () => {
  test('prints every operation plus the total vs cap without secret values', () => {
    const plan = buildSpendPlan({
      mode: 'live',
      narrationChars: 1000,
      narrationWillSubmit: true,
      music: OFFLINE_MUSIC,
    });
    const lines = formatCostTable(plan, 1);
    expect(lines.some((line) => line.includes('gen-audio'))).toBe(true);
    expect(lines.some((line) => line.includes('planned paid total'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/sk-|api[_-]?key\s*[=:]/i);
  });
});
