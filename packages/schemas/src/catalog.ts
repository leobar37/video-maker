/**
 * Catalog contract (`videos.json`, schemaVersion 3): the durable index of
 * video projects, generated from each project's declaration and sealed by
 * publish. Entries carry the latest public projection (`public`) and the last
 * durable snapshot (`archive`); editing a local draft never removes either.
 *
 * Entries are versioned by the root document; parsing also derives the
 * `product`/`slug` identity from `id` plus the bundle-presence flag used by
 * the `bundle-faltante` filter.
 */
import { z } from 'zod';

import { CATALOG_ID_PATTERN, COMMIT_PATTERN, Sha256Schema } from './primitives';

/** Version of the persisted catalog document. */
export const CATALOG_SCHEMA_VERSION = 3;

/** Projection of the latest published asset, sealed by publish. */
export const CatalogPublicSchema = z.object({
  schemaVersion: z.literal(3).optional(),
  id: z.string().min(1),
  version: z.string().min(1),
  url: z.string().optional(),
  cover: z.string().optional(),
  duration: z.number().finite().optional(),
  resolution: z.string().optional(),
  publishedAt: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type CatalogPublic = z.infer<typeof CatalogPublicSchema>;

/** Last durable snapshot of the project (content-addressed bundle). */
export const CatalogArchiveSchema = z.object({
  schemaVersion: z.literal(3).optional(),
  /** Storage key of the content-addressed bundle (`.../_bundles/<sha8>.zip`). */
  bundle: z.string().min(1),
  bucket: z.string().min(1).optional(),
  sha256: Sha256Schema.optional(),
  bytes: z.number().finite().nonnegative().optional(),
  repoCommit: z
    .string()
    .regex(COMMIT_PATTERN, 'repoCommit debe ser un SHA hexadecimal de 7 a 40 caracteres.')
    .optional(),
  bundledAt: z.string().optional(),
});
export type CatalogArchive = z.infer<typeof CatalogArchiveSchema>;

const CatalogEntryBaseSchema = z
  .object({
    schemaVersion: z.literal(3).optional(),
    /** `<producto>/<slug>`; `product`/`slug` are derived from it on parse. */
    id: z
      .string()
      .regex(CATALOG_ID_PATTERN, 'id debe ser producto/slug (ej. producto/01-lanzamiento).'),
    product: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    title: z.string().min(1, 'title debe ser un string no vacío.'),
    status: z.enum(['draft', 'published']),
    public: CatalogPublicSchema.optional(),
    archive: CatalogArchiveSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    const [product, slug] = entry.id.split('/');
    if (entry.product !== undefined && entry.product !== product) {
      ctx.addIssue({ code: 'custom', path: ['product'], message: 'product no coincide con id.' });
    }
    if (entry.slug !== undefined && entry.slug !== slug) {
      ctx.addIssue({ code: 'custom', path: ['slug'], message: 'slug no coincide con id.' });
    }
  });

/** Catalog entry with derived identity (`product`, `slug`) and bundle flag. */
export const CatalogEntrySchema = CatalogEntryBaseSchema.transform((entry) => {
  const [product, slug] = entry.id.split('/');
  return {
    ...entry,
    product: entry.product ?? product,
    slug: entry.slug ?? slug,
    /** Bundle-presence flag: `true` while a durable archive exists. */
    hasBundle: entry.archive !== undefined,
  };
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** The persisted catalog document. */
export const VideoCatalogSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    videos: z.array(CatalogEntrySchema),
  })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    catalog.videos.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['videos', index],
          message: `id duplicado "${entry.id}".`,
        });
      }
      seen.add(entry.id);
    });
  });
export type VideoCatalog = z.infer<typeof VideoCatalogSchema>;
