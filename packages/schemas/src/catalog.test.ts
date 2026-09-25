import { describe, expect, test } from 'bun:test';

import {
  CatalogEntrySchema,
  CATALOG_SCHEMA_VERSION,
  VideoCatalogSchema,
} from './catalog';

const sha = (char: string): string => char.repeat(64);

interface EntryFixture {
  id: string;
  title: string;
  status: string;
  public?: Record<string, unknown>;
  archive?: Record<string, unknown>;
}

const catalogFixture: { schemaVersion: number; videos: EntryFixture[] } = {
  schemaVersion: 3,
  videos: [
    {
      id: 'demo/01-lanzamiento',
      title: 'Demo — Lanzamiento',
      status: 'published',
      public: {
        id: 'demo/01-lanzamiento/lanzamiento-v2',
        version: 'lanzamiento-v2',
        url: 'https://cdn.example.com/demo/01-lanzamiento/lanzamiento-v2.mp4',
        cover: 'https://cdn.example.com/demo/01-lanzamiento/cover.png',
        duration: 39.14,
        resolution: '1080x1920',
        publishedAt: '2026-07-24T16:39:59.145Z',
        tags: ['demo', 'lanzamiento'],
      },
      archive: {
        bundle: 'bundles/demo/01-lanzamiento/d43d889a.zip',
        bucket: 'media',
        sha256: sha('a'),
        bytes: 22373,
        repoCommit: 'c6737500212c5d30bb5abb0327a114c162d4ecc5',
        bundledAt: '2026-09-18T17:27:35.414Z',
      },
    },
    { id: 'demo/02-borrador', title: 'Demo — Borrador', status: 'draft' },
  ],
};

function roundTrip<T>(schema: { parse: (raw: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

describe('VideoCatalogSchema', () => {
  test('round-trips a schemaVersion 3 catalog and derives the entry identity', () => {
    const parsed = VideoCatalogSchema.parse(catalogFixture);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.videos[0]).toMatchObject({
      id: 'demo/01-lanzamiento',
      product: 'demo',
      slug: '01-lanzamiento',
      title: 'Demo — Lanzamiento',
      status: 'published',
      hasBundle: true,
    });
    expect(parsed.videos[1]).toMatchObject({
      product: 'demo',
      slug: '02-borrador',
      status: 'draft',
      hasBundle: false,
    });
    // Parsing is idempotent: the derived view round-trips unchanged.
    expect(roundTrip(VideoCatalogSchema, parsed)).toEqual(parsed);
  });

  test('parses a minimal entry without public/archive blocks', () => {
    const parsed = CatalogEntrySchema.parse({ id: 'demo/03-minimo', title: 'Minimo', status: 'draft' });
    expect(parsed).toEqual({
      id: 'demo/03-minimo',
      title: 'Minimo',
      status: 'draft',
      product: 'demo',
      slug: '03-minimo',
      hasBundle: false,
    });
  });

  test('rejects a bad schemaVersion', () => {
    expect(VideoCatalogSchema.safeParse({ ...catalogFixture, schemaVersion: 2 }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...catalogFixture.videos[1], schemaVersion: 1 }).success).toBe(false);
  });

  test('rejects duplicated ids', () => {
    expect(
      VideoCatalogSchema.safeParse({
        schemaVersion: 3,
        videos: [catalogFixture.videos[1], catalogFixture.videos[1]],
      }).success,
    ).toBe(false);
  });

  test('rejects ids outside producto/slug', () => {
    for (const id of ['demo', 'demo/01/extra', '/01-lanzamiento', 'demo/', 'demo/01 lanzamiento']) {
      expect(CatalogEntrySchema.safeParse({ id, title: 'X', status: 'draft' }).success).toBe(false);
    }
  });

  test('rejects product/slug inconsistent with id', () => {
    expect(
      CatalogEntrySchema.safeParse({ ...catalogFixture.videos[1], product: 'otro' }).success,
    ).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({ ...catalogFixture.videos[1], slug: '99-otro' }).success,
    ).toBe(false);
  });

  test('rejects a malformed archive hash or commit', () => {
    const entry = catalogFixture.videos[0];
    expect(
      CatalogEntrySchema.safeParse({
        ...entry,
        archive: { ...entry.archive, sha256: 'no-es-un-sha256' },
      }).success,
    ).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({
        ...entry,
        archive: { ...entry.archive, repoCommit: 'xyz' },
      }).success,
    ).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({ ...entry, archive: { bundle: '' } }).success,
    ).toBe(false);
  });

  test('rejects a bad status, empty title or malformed public block', () => {
    expect(CatalogEntrySchema.safeParse({ ...catalogFixture.videos[1], status: 'archived' }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...catalogFixture.videos[1], title: '' }).success).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({ ...catalogFixture.videos[0], public: { version: 'v1' } }).success,
    ).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({
        ...catalogFixture.videos[0],
        public: { id: 'x', version: 'v1', tags: [7] },
      }).success,
    ).toBe(false);
  });

  test('exposes the current catalog schema version', () => {
    expect(CATALOG_SCHEMA_VERSION).toBe(3);
  });
});
