/**
 * Distribution (social-track) pure rules: entry merge, best-time parsing and
 * slot math.
 */
import { describe, expect, it } from 'bun:test';

import {
  limaLabel,
  mergeDistributionEntry,
  nextUtcOccurrence,
  parseBestTimeSlots,
  rankBestTimeSlots,
  toDistribution,
} from './distribution';

describe('mergeDistributionEntry', () => {
  it('upserts one network with the incoming status winning', () => {
    const first = mergeDistributionEntry(undefined, 'instagram', {
      status: 'pending',
      account: '@brand',
    });
    const second = mergeDistributionEntry(first, 'instagram', {
      status: 'published',
      url: 'https://social.example.com/p/1',
    });
    expect(second).toEqual({
      instagram: {
        status: 'published',
        account: '@brand',
        url: 'https://social.example.com/p/1',
      },
    });
    expect(first.instagram.status).toBe('pending'); // pure: no mutation
    expect(mergeDistributionEntry(second, 'tiktok', { status: 'failed' }).tiktok.status).toBe(
      'failed',
    );
  });
});

describe('best-time slots', () => {
  it('parses snake_case slots tolerantly and ranks by engagement', () => {
    const slots = parseBestTimeSlots({
      slots: [
        { day_of_week: 2, hour: 10, avg_engagement: 3 },
        { dayOfWeek: 0, hour: 15, avgEngagement: 9 },
        { day_of_week: 1, hour: 99, avg_engagement: 'x' },
        { broken: true },
      ],
    });
    expect(slots).toEqual([
      { dayOfWeek: 2, hour: 10, avgEngagement: 3 },
      { dayOfWeek: 0, hour: 15, avgEngagement: 9 },
      { dayOfWeek: 1, hour: 99 },
    ]);
    expect(rankBestTimeSlots(slots, 2).map((s) => s.hour)).toEqual([15, 10]);
  });
});

describe('nextUtcOccurrence / limaLabel', () => {
  it('finds the next occurrence of a weekly UTC slot (0 = Monday)', () => {
    const from = new Date('2026-09-24T12:00:00.000Z'); // Thursday
    const monday10 = nextUtcOccurrence(0, 10, from);
    expect(monday10.toISOString()).toBe('2026-09-28T10:00:00.000Z');
    const sameDayLater = nextUtcOccurrence(3, 15, from); // Thursday 15:00
    expect(sameDayLater.toISOString()).toBe('2026-09-24T15:00:00.000Z');
    const sameDayEarlier = nextUtcOccurrence(3, 9, from); // already past → next week
    expect(sameDayEarlier.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('labels instants in the operator timezone (UTC-5)', () => {
    expect(limaLabel(new Date('2026-09-24T15:00:00.000Z'))).toBe('thu 10:00 (UTC-5)');
    expect(limaLabel(new Date('2026-09-28T10:00:00.000Z'))).toBe('mon 05:00 (UTC-5)');
  });
});

describe('toDistribution', () => {
  it('maps a parsed post to per-platform entries', () => {
    expect(
      toDistribution({
        id: 'post-1',
        platforms: [
          { platform: 'instagram', status: 'published', platformPostUrl: 'https://social.example.com/p/1' },
          { platform: 'tiktok' },
        ],
      }),
    ).toEqual({
      remoteId: 'post-1',
      url: 'https://social.example.com/p/1',
      entries: [
        { platform: 'instagram', status: 'published', url: 'https://social.example.com/p/1' },
        { platform: 'tiktok', status: undefined, url: undefined },
      ],
    });
  });
});
