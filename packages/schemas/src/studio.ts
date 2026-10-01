/**
 * Studio domain contracts (creative workspace, schemaVersion 1): an open,
 * agent-first workshop independent of the legacy `VideoConfig`/catalog
 * pipeline. A project relates to zero or more clients, an asset is an open
 * working folder with declared deliverables (no template/layout/renderer is
 * ever required), and revisions seal exact outputs plus their sources,
 * inputs and presets.
 *
 * Canonical JSON / rootHash decisions (frozen by this module):
 * - The sealed payload is exactly `schemaVersion, projectSnapshot,
 *   clientSnapshots, assetSnapshot, presetSnapshots, recipeSnapshot, files,
 *   outputs`.
 * - `revisionId`, `createdAt`, `note`, `editorialStatus`,
 *   `parentRevisionId` and `rootHash` itself never influence the hash.
 * - Canonical form: object keys sorted recursively (code-unit order), no
 *   whitespace, UTF-8; semantic arrays keep their order EXCEPT `files`,
 *   which is normalized sorted by `path` (byte order).
 * - Canonical inputs must be pure JSON data — no undefined, functions,
 *   symbols, BigInt, NaN/Infinity, sparse arrays, getters, cycles or
 *   non-plain objects. Silent coercions like `NaN → null` would collide
 *   distinct data and corrupt the seal; validation rejects instead.
 * - `rootHash` is SHA-256 over the canonical payload bytes. It is a studio
 *   domain digest: it never reuses or mixes with any legacy bundle hash.
 *
 * All domain documents are `strictObject`s: unknown keys are rejected so
 * accidental metadata or future fields fail loudly instead of silently
 * diverging from the persisted contract.
 */
import { z } from 'zod';

import { COMMIT_PATTERN, HttpUrlSchema, IsoTimestampSchema, Sha256Schema, SLUG_PATTERN } from './primitives';

/** Version of every persisted studio domain document. */
export const STUDIO_SCHEMA_VERSION = 1;

/** Public, stable error codes of the studio services (contracts.md §5). */
export const STUDIO_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'PATH_UNSAFE',
  'SECRET_PATH',
  'OUTPUT_MISSING',
  'HASH_MISMATCH',
  'CONFLICT',
  'STORAGE_UNAVAILABLE',
  'AUTH_REQUIRED',
  'RECIPE_FAILED',
] as const;
export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];

/** Bare media type (`image/png`), parameters are not part of the contract. */
export const MEDIA_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

/** Entity id: kebab-case slug, never a path. */
export const StudioIdSchema = z
  .string()
  .min(1)
  .regex(SLUG_PATTERN, 'Debe ser un id kebab-case: ^[a-z0-9][a-z0-9-]*$.');
export type StudioId = z.infer<typeof StudioIdSchema>;

/** Output name inside one asset: slug-like, usable in service routes. */
export const OUTPUT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Safe relative path (portable manifest space): no absolute prefix, no
 * `..` traversal, no backslashes, no `~`, no `:` (rejects drive letters and
 * URL schemes, including signed URLs), no NUL bytes, no empty segments.
 * A trailing slash is allowed for directory entries (`sources`/`inputs`).
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (value.includes('\\') || value.includes(':')) return false;
  const segments = value.replace(/\/+$/, '').split('/');
  if (segments.length === 0) return false;
  return segments.every((segment) => segment.length > 0 && segment !== '..');
}

/** Safe relative path that additionally forbids a trailing slash (a file). */
export function isSafeRelativeFilePath(value: string): boolean {
  return !value.endsWith('/') && isSafeRelativePath(value);
}

const SafePathSchema = z.string().refine(isSafeRelativePath, {
  message: 'Debe ser una ruta relativa segura (sin absolutas, .., \\, :, ~ ni URLs).',
});
const SafeFilePathSchema = z.string().refine(isSafeRelativeFilePath, {
  message: 'Debe ser una ruta relativa segura a un archivo (sin absolutas, .., \\, :, ~ ni URLs).',
});
const MediaTypeSchema = z.string().regex(MEDIA_TYPE_PATTERN, 'Debe ser un media type tipo/subtype.');
const StudioVersionSchema = z.literal(STUDIO_SCHEMA_VERSION).default(STUDIO_SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// Client / PresetVersion — brand identity, versioned and immutable
// ---------------------------------------------------------------------------

/** Exact reference to one immutable preset version. */
export const PresetRefSchema = z.strictObject({
  presetId: StudioIdSchema,
  versionId: StudioIdSchema,
});
export type PresetRef = z.infer<typeof PresetRefSchema>;

/** Client document (`clients/<clientId>/client.json`). Metadata must be non-secret. */
export const StudioClientSchema = z.strictObject({
  schemaVersion: StudioVersionSchema,
  id: StudioIdSchema,
  name: z.string().min(1),
  presetRefs: z.array(PresetRefSchema).optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((metadata) => studioJsonDataError(metadata) === null, {
      message:
        'metadata debe ser data JSON pura (sin undefined, funciones, símbolos, BigInt, NaN/Infinity, arrays dispersos, ciclos ni objetos no planos).',
    })
    .optional(),
});
export type StudioClient = z.infer<typeof StudioClientSchema>;

/** Optional brand identity carried by a preset version. */
export const PresetIdentitySchema = z.strictObject({
  palette: z.array(z.string()).optional(),
  fonts: z.array(z.string()).optional(),
  tone: z.string().optional(),
  rules: z.array(z.string()).optional(),
});
export type PresetIdentity = z.infer<typeof PresetIdentitySchema>;

/** Preset resource addressed by path (inside the version dir) + content hash. */
export const PresetResourceSchema = z.strictObject({
  path: SafePathSchema,
  sha256: Sha256Schema,
  mediaType: MediaTypeSchema.optional(),
});
export type PresetResource = z.infer<typeof PresetResourceSchema>;

/** Visual reference: either an http(s) URL or a path inside the version dir. */
export const PresetVisualRefSchema = z
  .strictObject({
    url: HttpUrlSchema.optional(),
    path: SafePathSchema.optional(),
    note: z.string().optional(),
  })
  .refine((ref) => ref.url !== undefined || ref.path !== undefined, {
    message: 'Una referencia visual necesita url o path.',
  });
export type PresetVisualRef = z.infer<typeof PresetVisualRefSchema>;

/**
 * Preset version document (`presets/<presetId>/versions/<versionId>/preset.json`).
 * Immutable snapshot: changing a logo or colors creates a NEW version.
 * `clientId` must reference an existing client (enforced by services).
 */
export const PresetVersionSchema = z.strictObject({
  schemaVersion: StudioVersionSchema,
  presetId: StudioIdSchema,
  versionId: StudioIdSchema,
  clientId: StudioIdSchema,
  name: z.string().min(1),
  identity: PresetIdentitySchema.optional(),
  resources: z.array(PresetResourceSchema).optional(),
  visualRefs: z.array(PresetVisualRefSchema).optional(),
});
export type PresetVersion = z.infer<typeof PresetVersionSchema>;

// ---------------------------------------------------------------------------
// CreativeProject / CreativeAsset — open workshop, never client-locked
// ---------------------------------------------------------------------------

/** Project document (`projects/<projectId>/project.json`). `clientIds: []` is valid. */
export const CreativeProjectSchema = z
  .strictObject({
    schemaVersion: StudioVersionSchema,
    id: StudioIdSchema,
    name: z.string().min(1),
    clientIds: z.array(StudioIdSchema).default([]),
  })
  .refine((project) => new Set(project.clientIds).size === project.clientIds.length, {
    message: 'clientIds no debe repetir clientes.',
  });
export type CreativeProject = z.infer<typeof CreativeProjectSchema>;

/** Declared deliverable/preview/thumbnail of an asset. Private by default. */
export const OutputSpecSchema = z.strictObject({
  name: z.string().regex(OUTPUT_NAME_PATTERN, 'Nombre de output inválido (slug-like, sin /).'),
  path: SafeFilePathSchema,
  mediaType: MediaTypeSchema,
  role: z.enum(['deliverable', 'preview', 'thumbnail']),
  visibility: z.enum(['private', 'public']).default('private'),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

/** Explicit, optional recipe. `argv` is an exec array, never a `sh -c` line. */
export const RecipeSchema = z
  .strictObject({
    argv: z.array(z.string().min(1)).min(1),
    cwd: SafePathSchema.default('.'),
    outputs: z.array(SafeFilePathSchema).min(1),
    toolchain: z
      .strictObject({
        versions: z.record(z.string(), z.string()).optional(),
        repoCommit: z.string().regex(COMMIT_PATTERN).optional(),
        lockfile: SafeFilePathSchema.optional(),
      })
      .optional(),
  })
  .refine((recipe) => new Set(recipe.outputs).size === recipe.outputs.length, {
    message: 'recipe.outputs no debe repetir rutas.',
  });
export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * Asset document (`projects/<projectId>/assets/<assetId>/asset.json`): an
 * open folder of work. Paths are relative to the asset directory;
 * `sources`/`inputs` may be directories, outputs are individual files.
 * Neither outputs nor a recipe are required to create an asset.
 */
export const CreativeAssetSchema = z
  .strictObject({
    schemaVersion: StudioVersionSchema,
    id: StudioIdSchema,
    projectId: StudioIdSchema,
    kind: z.enum(['image', 'video', 'svg', 'other']),
    title: z.string().min(1),
    presetRefs: z.array(PresetRefSchema).default([]),
    sources: z.array(SafePathSchema).default([]),
    inputs: z.array(SafePathSchema).default([]),
    outputs: z.array(OutputSpecSchema).default([]),
    recipe: RecipeSchema.optional(),
  })
  .superRefine((asset, ctx) => {
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const output of asset.outputs) {
      if (names.has(output.name)) {
        ctx.addIssue({ code: 'custom', path: ['outputs'], message: `Nombre de output duplicado: ${output.name}.` });
      }
      names.add(output.name);
      if (paths.has(output.path)) {
        ctx.addIssue({ code: 'custom', path: ['outputs'], message: `Ruta de output duplicada: ${output.path}.` });
      }
      paths.add(output.path);
    }
    if (asset.recipe) {
      for (const recipeOutput of asset.recipe.outputs) {
        if (!paths.has(recipeOutput)) {
          ctx.addIssue({
            code: 'custom',
            path: ['recipe', 'outputs'],
            message: `recipe.outputs declara una ruta externa al asset: ${recipeOutput}.`,
          });
        }
      }
    }
  });
export type CreativeAsset = z.infer<typeof CreativeAssetSchema>;

// ---------------------------------------------------------------------------
// RevisionManifest / SnapshotFile — portable, content-addressed seal
// ---------------------------------------------------------------------------

/** One sealed file inside the portable snapshot space. Paths are unique. */
export const SnapshotFileSchema = z.strictObject({
  path: SafeFilePathSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  mediaType: MediaTypeSchema,
  role: z.enum(['source', 'input', 'output', 'metadata', 'preset']),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

/** Manifest output: references a file that must exist inside `files`. */
export const ManifestOutputRefSchema = z.strictObject({
  name: z.string().regex(OUTPUT_NAME_PATTERN, 'Nombre de output inválido (slug-like, sin /).'),
  path: SafeFilePathSchema,
});
export type ManifestOutputRef = z.infer<typeof ManifestOutputRefSchema>;

export const EditorialStatusSchema = z.enum(['draft', 'approved', 'rejected']);
export type EditorialStatus = z.infer<typeof EditorialStatusSchema>;

/**
 * Revision manifest (`revisions/<projectId>/<assetId>/<revisionId>/manifest.json`):
 * the portable commit of one asset revision. It embeds project/client/asset
 * metadata snapshots and the exact preset versions with their resources, so
 * restoring never depends on a registry or on mutable `latest` pointers.
 * Manifest outputs only reference sealed files whose role is `output`, and
 * every preset owner is snapshotted in `clientSnapshots` even when the
 * brand does not take part in `projectSnapshot.clientIds`.
 */
export const RevisionManifestSchema = z
  .strictObject({
    schemaVersion: StudioVersionSchema,
    projectId: StudioIdSchema,
    assetId: StudioIdSchema,
    revisionId: StudioIdSchema,
    parentRevisionId: StudioIdSchema.optional(),
    createdAt: IsoTimestampSchema,
    note: z.string().default(''),
    editorialStatus: EditorialStatusSchema.default('draft'),
    projectSnapshot: CreativeProjectSchema,
    clientSnapshots: z.array(StudioClientSchema).default([]),
    assetSnapshot: CreativeAssetSchema,
    presetSnapshots: z.array(PresetVersionSchema).default([]),
    recipeSnapshot: RecipeSchema.optional(),
    files: z.array(SnapshotFileSchema).min(1),
    outputs: z.array(ManifestOutputRefSchema).min(1),
    rootHash: Sha256Schema,
  })
  .superRefine((manifest, ctx) => {
    if (manifest.projectSnapshot.id !== manifest.projectId) {
      ctx.addIssue({ code: 'custom', path: ['projectSnapshot', 'id'], message: 'projectSnapshot.id no coincide con projectId.' });
    }
    if (manifest.assetSnapshot.id !== manifest.assetId) {
      ctx.addIssue({ code: 'custom', path: ['assetSnapshot', 'id'], message: 'assetSnapshot.id no coincide con assetId.' });
    }
    if (manifest.assetSnapshot.projectId !== manifest.projectId) {
      ctx.addIssue({ code: 'custom', path: ['assetSnapshot', 'projectId'], message: 'assetSnapshot.projectId no coincide con projectId.' });
    }

    const filePaths = new Set(manifest.files.map((file) => file.path));
    if (filePaths.size !== manifest.files.length) {
      ctx.addIssue({ code: 'custom', path: ['files'], message: 'files contiene rutas duplicadas.' });
    }

    const clientIds = new Set(manifest.clientSnapshots.map((client) => client.id));
    if (clientIds.size !== manifest.clientSnapshots.length) {
      ctx.addIssue({ code: 'custom', path: ['clientSnapshots'], message: 'clientSnapshots contiene clientes duplicados.' });
    }
    for (const clientId of manifest.projectSnapshot.clientIds) {
      if (!clientIds.has(clientId)) {
        ctx.addIssue({ code: 'custom', path: ['clientSnapshots'], message: `Falta el snapshot del cliente ${clientId} declarado en el proyecto.` });
      }
    }
    for (const preset of manifest.presetSnapshots) {
      if (!clientIds.has(preset.clientId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presetSnapshots'],
          message: `Falta el snapshot del cliente ${preset.clientId}, dueño del preset ${preset.presetId}.`,
        });
      }
    }

    const presetKeys = new Set(manifest.presetSnapshots.map((preset) => `${preset.presetId}@${preset.versionId}`));
    if (presetKeys.size !== manifest.presetSnapshots.length) {
      ctx.addIssue({ code: 'custom', path: ['presetSnapshots'], message: 'presetSnapshots contiene versiones duplicadas.' });
    }
    for (const ref of manifest.assetSnapshot.presetRefs) {
      if (!presetKeys.has(`${ref.presetId}@${ref.versionId}`)) {
        ctx.addIssue({ code: 'custom', path: ['presetSnapshots'], message: `Falta el preset exacto ${ref.presetId}@${ref.versionId} referenciado por el asset.` });
      }
    }

    const declaredOutputNames = new Set(manifest.assetSnapshot.outputs.map((output) => output.name));
    const fileRoles = new Map(manifest.files.map((file) => [file.path, file.role] as const));
    const outputNames = new Set<string>();
    for (const output of manifest.outputs) {
      if (outputNames.has(output.name)) {
        ctx.addIssue({ code: 'custom', path: ['outputs'], message: `Output duplicado en el manifest: ${output.name}.` });
      }
      outputNames.add(output.name);
      const fileRole = fileRoles.get(output.path);
      if (fileRole === undefined) {
        ctx.addIssue({ code: 'custom', path: ['outputs'], message: `El output ${output.name} apunta a un archivo inexistente en files: ${output.path}.` });
      } else if (fileRole !== 'output') {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs'],
          message: `El output ${output.name} apunta a un file con rol ${fileRole}; los outputs del manifest solo pueden referenciar files con rol output.`,
        });
      }
      if (!declaredOutputNames.has(output.name)) {
        ctx.addIssue({ code: 'custom', path: ['outputs'], message: `El output ${output.name} no está declarado en assetSnapshot.outputs.` });
      }
    }
  });
export type RevisionManifest = z.infer<typeof RevisionManifestSchema>;

// ---------------------------------------------------------------------------
// SyncReceipt / ProjectCheckpoint — backup state, outside the manifest
// ---------------------------------------------------------------------------

export const SyncStatusSchema = z.enum(['local', 'syncing', 'confirmed', 'failed']);
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/** Public studio error shape: stable code, message, redacted details. */
export const StudioErrorSchema = z.strictObject({
  code: z.enum(STUDIO_ERROR_CODES),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type StudioError = z.infer<typeof StudioErrorSchema>;

/**
 * Receipt of the backup protocol for one revision (`.vm/receipts/...`).
 * Kept OUTSIDE the manifest: a boolean `backup: true` on the asset proves
 * nothing; only a verified receipt does.
 */
export const SyncReceiptSchema = z.strictObject({
  schemaVersion: StudioVersionSchema,
  projectId: StudioIdSchema,
  assetId: StudioIdSchema,
  revisionId: StudioIdSchema,
  rootHash: Sha256Schema,
  manifestKey: z.string().min(1),
  manifestSha256: Sha256Schema,
  status: SyncStatusSchema.default('local'),
  confirmedObjects: z.array(z.string().min(1)).default([]),
  error: StudioErrorSchema.optional(),
});
export type SyncReceipt = z.infer<typeof SyncReceiptSchema>;

/** One entry of the immutable checkpoint map. */
export const CheckpointEntrySchema = z.strictObject({
  assetId: StudioIdSchema,
  revisionId: StudioIdSchema,
  rootHash: Sha256Schema,
});
export type CheckpointEntry = z.infer<typeof CheckpointEntrySchema>;

/**
 * Project checkpoint (`checkpoints/<projectId>/<checkpointId>.json`): an
 * immutable assetId → revisionId/rootHash map. It never duplicates files
 * and never points to a nonexistent revision.
 */
export const ProjectCheckpointSchema = z
  .strictObject({
    schemaVersion: StudioVersionSchema,
    projectId: StudioIdSchema,
    checkpointId: StudioIdSchema,
    createdAt: IsoTimestampSchema,
    entries: z.array(CheckpointEntrySchema),
  })
  .refine((checkpoint) => new Set(checkpoint.entries.map((entry) => entry.assetId)).size === checkpoint.entries.length, {
    message: 'Un checkpoint declara un asset como máximo una vez.',
  });
export type ProjectCheckpoint = z.infer<typeof ProjectCheckpointSchema>;

// ---------------------------------------------------------------------------
// StudioCatalog — frozen read-only DTO for the dashboard (P-005)
// ---------------------------------------------------------------------------

/** Service-facing output projection. Service URLs are ephemeral and are
 * never written inside a manifest. */
export const StudioCatalogOutputSchema = z.strictObject({
  name: z.string().regex(OUTPUT_NAME_PATTERN),
  mediaType: MediaTypeSchema,
  role: z.enum(['deliverable', 'preview', 'thumbnail']),
  visibility: z.enum(['private', 'public']),
  servicePath: z.string().min(1),
});
export type StudioCatalogOutput = z.infer<typeof StudioCatalogOutputSchema>;

/** One revision of one asset, with separated editorial/production/backup state. */
export const StudioCatalogEntrySchema = z.strictObject({
  projectId: StudioIdSchema,
  assetId: StudioIdSchema,
  revisionId: StudioIdSchema,
  rootHash: Sha256Schema,
  project: z.strictObject({ id: StudioIdSchema, name: z.string().min(1) }),
  clients: z.array(z.strictObject({ id: StudioIdSchema, name: z.string().min(1) })).default([]),
  asset: z.strictObject({
    id: StudioIdSchema,
    kind: z.enum(['image', 'video', 'svg', 'other']),
    title: z.string().min(1),
    presetRefs: z.array(PresetRefSchema).default([]),
  }),
  presets: z.array(z.strictObject({ presetId: StudioIdSchema, versionId: StudioIdSchema, clientId: StudioIdSchema, name: z.string().min(1) })).default([]),
  outputs: z.array(StudioCatalogOutputSchema).default([]),
  editorialStatus: EditorialStatusSchema,
  production: z
    .strictObject({
      presentOutputs: z.array(z.string().regex(OUTPUT_NAME_PATTERN)).default([]),
      missingOutputs: z.array(z.string().regex(OUTPUT_NAME_PATTERN)).default([]),
    })
    .default({ presentOutputs: [], missingOutputs: [] }),
  backup: z
    .strictObject({
      status: SyncStatusSchema,
      receiptVerified: z.boolean().default(false),
    })
    .default({ status: 'local', receiptVerified: false }),
  errors: z.array(StudioErrorSchema).default([]),
});
export type StudioCatalogEntry = z.infer<typeof StudioCatalogEntrySchema>;

/** The read-only catalog consumed by the single dashboard. */
export const StudioCatalogSchema = z.strictObject({
  schemaVersion: StudioVersionSchema,
  entries: z.array(StudioCatalogEntrySchema).default([]),
});
export type StudioCatalog = z.infer<typeof StudioCatalogSchema>;

// ---------------------------------------------------------------------------
// Canonical JSON + sealed-content rootHash (pure domain module)
// ---------------------------------------------------------------------------

/** JSON data accepted by the canonical form: exactly what `JSON.parse` can produce. */
export type StudioJsonValue = string | number | boolean | null | StudioJsonValue[] | { [key: string]: StudioJsonValue };

/**
 * Reason a value is NOT pure studio JSON data (`null` when it is): finite
 * numbers, strings, booleans, null, dense arrays and plain objects only.
 * Iterative and getter-free — own data-property descriptors are inspected,
 * never invoked — so accessors cannot execute and cyclic inputs cannot
 * overflow the call stack before validation rejects them.
 */
function studioJsonDataError(root: unknown): string | null {
  const VISITING = 1;
  const DONE = 2;
  const marks = new Map<object, number>();
  type ContainerEntry = { key: string | null; value: unknown };
  type ContainerFrame = { node: object; entries: ContainerEntry[]; index: number };
  const stack: ContainerFrame[] = [];

  const describeContainer = (node: object): { entries: ContainerEntry[] } | string => {
    if (Array.isArray(node)) {
      if (Object.getPrototypeOf(node) !== Array.prototype) return 'array no plano';
      const entries: ContainerEntry[] = [];
      for (let index = 0; index < node.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
        if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
          return `array disperso o con accessor en el índice ${index}`;
        }
        entries.push({ key: null, value: descriptor.value });
      }
      if (Object.keys(node).length !== node.length) return 'array con claves propias extra';
      return { entries };
    }
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) return 'objeto no plano';
    const entries: ContainerEntry[] = [];
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !('value' in descriptor)) return `accessor (getter/setter) en la clave ${key}`;
      entries.push({ key, value: descriptor.value });
    }
    return { entries };
  };

  const visit = (candidate: unknown): string | null => {
    if (candidate === null) return null;
    if (typeof candidate !== 'object') {
      const kind = typeof candidate;
      if (kind === 'string' || kind === 'boolean') return null;
      if (kind === 'number') return Number.isFinite(candidate) ? null : 'número no finito (NaN o Infinity)';
      return `valor de tipo ${kind}, que no es JSON`;
    }
    const mark = marks.get(candidate);
    if (mark === VISITING) return 'ciclo detectado';
    if (mark === DONE) return null;
    const described = describeContainer(candidate);
    if (typeof described === 'string') return described;
    marks.set(candidate, VISITING);
    stack.push({ node: candidate, entries: described.entries, index: 0 });
    return null;
  };

  let error = visit(root);
  while (error === null && stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.entries.length) {
      stack.pop();
      marks.set(frame.node, DONE);
      continue;
    }
    const entry = frame.entries[frame.index];
    frame.index += 1;
    error = visit(entry.value);
  }
  return error;
}

/** Canonical serialization frame: `keys === null` means an array. */
interface CanonicalFrame {
  entries: string[];
  keys: string[] | null;
  values: unknown[];
  index: number;
  prefix: string;
}

function canonicalFrame(value: unknown, prefix: string): CanonicalFrame | null {
  if (Array.isArray(value)) {
    return { entries: [], keys: null, values: value, index: 0, prefix };
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    const record = value as Record<string, unknown>;
    return { entries: [], keys, values: keys.map((key) => record[key]), index: 0, prefix };
  }
  return null;
}

function canonicalPrimitive(value: unknown): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/**
 * Canonical JSON: object keys sorted recursively (code-unit order), no
 * whitespace, array order preserved. Non-JSON inputs are rejected with a
 * `TypeError` instead of being coerced: `JSON.stringify` would collapse
 * `NaN`/`Infinity` into `null` (colliding distinct data) and recursion
 * would overflow on cycles. Valid JSON bytes are emitted unchanged.
 */
export function canonicalStudioJson(value: StudioJsonValue): string {
  const error = studioJsonDataError(value);
  if (error !== null) {
    throw new TypeError(`canonicalStudioJson: la entrada no es data JSON (${error}).`);
  }
  const rootFrame = canonicalFrame(value, '');
  if (rootFrame === null) return canonicalPrimitive(value);
  const stack: CanonicalFrame[] = [rootFrame];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.values.length) {
      stack.pop();
      const text = frame.prefix + (frame.keys === null ? `[${frame.entries.join(',')}]` : `{${frame.entries.join(',')}}`);
      const parent = stack[stack.length - 1];
      if (parent === undefined) return text;
      parent.entries.push(text);
      continue;
    }
    const index = frame.index;
    frame.index += 1;
    const key = frame.keys === null ? null : frame.keys[index];
    const child = frame.values[index];
    const childFrame = canonicalFrame(child, key === null ? '' : `${JSON.stringify(key)}:`);
    if (childFrame === null) {
      const serialized = canonicalPrimitive(child);
      frame.entries.push(key === null ? serialized : `${JSON.stringify(key)}:${serialized}`);
    } else {
      stack.push(childFrame);
    }
  }
  return '';
}

/** The exact payload sealed by `rootHash` (contracts.md §3). */
export interface RevisionSealPayload {
  schemaVersion: typeof STUDIO_SCHEMA_VERSION;
  projectSnapshot: CreativeProject;
  clientSnapshots: StudioClient[];
  assetSnapshot: CreativeAsset;
  presetSnapshots: PresetVersion[];
  recipeSnapshot?: Recipe | undefined;
  files: SnapshotFile[];
  outputs: ManifestOutputRef[];
}

/**
 * Build the seal payload from a manifest: only contract fields, with `files`
 * normalized sorted by path. Optional fields are omitted explicitly — the
 * validated manifest projects either a defined value or no key at all, and
 * the payload must never carry `undefined` (canonical JSON rejects it).
 * Producers should emit semantic arrays in a stable order (e.g. snapshots
 * sorted by id) so identical content seals identically regardless of when
 * it was produced.
 */
export function buildRevisionSealPayload(manifest: RevisionManifest): RevisionSealPayload {
  const payload: RevisionSealPayload = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    projectSnapshot: manifest.projectSnapshot,
    clientSnapshots: manifest.clientSnapshots,
    assetSnapshot: manifest.assetSnapshot,
    presetSnapshots: manifest.presetSnapshots,
    files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    outputs: manifest.outputs,
  };
  if (manifest.recipeSnapshot !== undefined) {
    payload.recipeSnapshot = manifest.recipeSnapshot;
  }
  return payload;
}

/** SHA-256 over raw bytes, lowercase hex (never an ETag). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 of the canonical seal payload. */
export async function hashRevisionSealPayload(payload: RevisionSealPayload): Promise<string> {
  return sha256Hex(canonicalStudioJson(payload as unknown as StudioJsonValue));
}

/**
 * Studio domain rootHash of one revision. Two snapshots of the same sealed
 * content produce the same digest even when their ids, timestamps, notes or
 * editorial state differ. This is a new domain digest: it is not the legacy
 * bundle hash and must never be mixed with it.
 */
export async function computeRevisionRootHash(manifest: RevisionManifest): Promise<string> {
  return hashRevisionSealPayload(buildRevisionSealPayload(manifest));
}
