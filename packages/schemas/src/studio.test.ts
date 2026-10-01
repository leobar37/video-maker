/**
 * Studio domain suites: schema validation (positive + negative), version
 * control, unknown-metadata rejection, safe paths, portable manifests,
 * receipts/checkpoints, the frozen catalog DTO and the canonical-JSON /
 * rootHash rules of contracts.md §3.
 *
 * Fixtures are synthetic and non-secret by construction.
 */
import { describe, expect, test } from 'bun:test';

import {
  buildRevisionSealPayload,
  canonicalStudioJson,
  computeRevisionRootHash,
  CreativeProjectSchema,
  CreativeAssetSchema,
  hashRevisionSealPayload,
  ProjectCheckpointSchema,
  RevisionManifestSchema,
  sha256Hex,
  StudioCatalogEntrySchema,
  StudioClientSchema,
  SyncReceiptSchema,
  type RevisionManifest,
  type StudioJsonValue,
} from './studio';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);
const SHA_F = 'f'.repeat(64);
const SHA_G = '0123456789abcdef'.repeat(4);

const clientA = { schemaVersion: 1, id: 'marca-a', name: 'Marca A' };
const clientB = { schemaVersion: 1, id: 'marca-b', name: 'Marca B', metadata: { region: 'latam' } };

const presetA = {
  schemaVersion: 1,
  presetId: 'preset-a',
  versionId: 'v001',
  clientId: 'marca-a',
  name: 'Marca A 2026',
  identity: { palette: ['#0a1f44', '#f5f5f5'], fonts: ['Inter'], tone: 'sobrio', rules: ['contraste mínimo AA'] },
  resources: [{ path: 'resources/logo.png', sha256: SHA_A, mediaType: 'image/png' }],
};
const presetB = {
  schemaVersion: 1,
  presetId: 'preset-b',
  versionId: 'v002',
  clientId: 'marca-b',
  name: 'Marca B Fiesta',
};

const projectTwoClients = {
  schemaVersion: 1,
  id: 'campana-verano',
  name: 'Campaña Verano',
  clientIds: ['marca-a', 'marca-b'],
};

const assetImage = {
  schemaVersion: 1,
  id: 'cover-feed',
  projectId: 'campana-verano',
  kind: 'image',
  title: 'Cover feed doble marca',
  presetRefs: [
    { presetId: 'preset-a', versionId: 'v001' },
    { presetId: 'preset-b', versionId: 'v002' },
  ],
  sources: ['workroom/cover.html', 'workroom/assets/'],
  inputs: ['inputs/brief.md'],
  outputs: [
    { name: 'cover-feed-v1', path: 'outputs/cover-feed-v1.png', mediaType: 'image/png', role: 'deliverable' },
    { name: 'cover-feed-preview', path: 'outputs/cover-feed-preview.jpg', mediaType: 'image/jpeg', role: 'preview' },
  ],
  recipe: { argv: ['bun', 'run', 'workroom/render.ts'], cwd: '.', outputs: ['outputs/cover-feed-v1.png'] },
};

const files = [
  { path: 'metadata/asset.json', sha256: SHA_B, bytes: 640, mediaType: 'application/json', role: 'metadata' },
  { path: 'sources/workroom/cover.html', sha256: SHA_C, bytes: 2048, mediaType: 'text/html', role: 'source' },
  { path: 'sources/inputs/brief.md', sha256: SHA_D, bytes: 300, mediaType: 'text/markdown', role: 'input' },
  { path: 'presets/preset-a/v001/preset.json', sha256: SHA_E, bytes: 512, mediaType: 'application/json', role: 'preset' },
  { path: 'presets/preset-a/v001/resources/logo.png', sha256: SHA_A, bytes: 42_000, mediaType: 'image/png', role: 'preset' },
  { path: 'outputs/cover-feed-v1.png', sha256: SHA_F, bytes: 88_000, mediaType: 'image/png', role: 'output' },
  { path: 'outputs/cover-feed-preview.jpg', sha256: SHA_G, bytes: 31_000, mediaType: 'image/jpeg', role: 'output' },
];

const manifestOutputs = [
  { name: 'cover-feed-v1', path: 'outputs/cover-feed-v1.png' },
  { name: 'cover-feed-preview', path: 'outputs/cover-feed-preview.jpg' },
];

/** Validated manifest example (handoff artifact for P-002+). */
function buildManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'campana-verano',
    assetId: 'cover-feed',
    revisionId: 'r001',
    createdAt: '2026-09-30T20:40:00.000Z',
    note: 'primera versión',
    editorialStatus: 'draft',
    projectSnapshot: projectTwoClients,
    clientSnapshots: [clientA, clientB],
    assetSnapshot: assetImage,
    presetSnapshots: [presetA, presetB],
    recipeSnapshot: assetImage.recipe,
    files,
    outputs: manifestOutputs,
    rootHash: SHA_A,
    ...overrides,
  };
}

function parseManifest(overrides: Record<string, unknown> = {}): RevisionManifest {
  return RevisionManifestSchema.parse(buildManifest(overrides));
}

// ---------------------------------------------------------------------------
// Entities: clients, presets, projects, assets
// ---------------------------------------------------------------------------

describe('studio schemas · entidades v1', () => {
  test('client mínimo válido; metadata arbitraria no secreta aceptada', () => {
    expect(StudioClientSchema.parse(clientA)).toMatchObject({ id: 'marca-a', name: 'Marca A' });
    expect(StudioClientSchema.parse({ ...clientB, metadata: { owner: 'equipo-creativo' } }).metadata).toEqual({
      owner: 'equipo-creativo',
    });
  });
  test('metadata de client debe ser data JSON: ciclos, NaN, undefined y objetos no planos rechazados', () => {
    const cyclic: Record<string, unknown> = { region: 'latam' };
    cyclic.self = cyclic;
    expect(() => StudioClientSchema.parse({ ...clientB, metadata: cyclic })).toThrow();
    expect(() => StudioClientSchema.parse({ ...clientB, metadata: { n: Number.NaN } })).toThrow();
    expect(() => StudioClientSchema.parse({ ...clientB, metadata: { token: undefined } })).toThrow();
    expect(() => StudioClientSchema.parse({ ...clientB, metadata: { when: new Date(0) } })).toThrow();
    expect(StudioClientSchema.parse({ ...clientB, metadata: { region: 'latam', anidado: { lista: [1, 2] } } }).metadata).toEqual({
      region: 'latam',
      anidado: { lista: [1, 2] },
    });
  });

  test('proyecto sin clientes y con dos clientes son válidos; clientIds por defecto []', () => {
    const noClients = CreativeProjectSchema.parse({ schemaVersion: 1, id: 'sandbox', name: 'Sandbox' });
    expect(noClients.clientIds).toEqual([]);
    const two = CreativeProjectSchema.parse(projectTwoClients);
    expect(two.clientIds).toEqual(['marca-a', 'marca-b']);
  });

  test('rechaza clientIds duplicados', () => {
    expect(() =>
      CreativeProjectSchema.parse({ ...projectTwoClients, clientIds: ['marca-a', 'marca-a'] }),
    ).toThrow();
  });

  test('asset abierto: sin outputs ni recipe, presets de dos marcas', () => {
    const asset = CreativeAssetSchema.parse({
      schemaVersion: 1,
      id: 'cover-story',
      projectId: 'campana-verano',
      kind: 'svg',
      title: 'Boceto story',
      presetRefs: assetImage.presetRefs,
    });
    expect(asset.outputs).toEqual([]);
    expect(asset.recipe).toBeUndefined();
    expect(asset.presetRefs).toHaveLength(2);
  });

  test('output: role requerido, visibility private por defecto', () => {
    const [output] = CreativeAssetSchema.parse({ ...assetImage, outputs: [{ ...assetImage.outputs[0], visibility: undefined }] }).outputs;
    expect(output.visibility).toBe('private');
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, outputs: [{ ...assetImage.outputs[0], role: undefined }] }),
    ).toThrow();
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, outputs: [{ ...assetImage.outputs[0], visibility: 'internal' }] }),
    ).toThrow();
  });

  test('control de versiones: schemaVersion 2 y metadata desconocida rechazados', () => {
    expect(() => CreativeProjectSchema.parse({ ...projectTwoClients, schemaVersion: 2 })).toThrow();
    expect(() => StudioClientSchema.parse({ ...clientA, extra: 'no' })).toThrow();
    expect(() => CreativeAssetSchema.parse({ ...assetImage, layout: 'grid' })).toThrow();
  });

  test('ids kebab-case; rutas absolutas/traversal/URL/slashes dobles rechazadas', () => {
    expect(() => CreativeProjectSchema.parse({ ...projectTwoClients, id: 'Campaña Verano' })).toThrow();
    expect(() => CreativeProjectSchema.parse({ ...projectTwoClients, id: 'campana/../verano' })).toThrow();
    for (const path of ['/etc/passwd', '../fuera.html', 'workroom\\cover.html', '~/secrets', 'file:///etc/passwd', 'workroom//cover.html']) {
      expect(() => CreativeAssetSchema.parse({ ...assetImage, sources: [path] }), path).toThrow();
    }
    const withDir = CreativeAssetSchema.parse({ ...assetImage, sources: ['workroom/assets/'] });
    expect(withDir.sources).toEqual(['workroom/assets/']);
    expect(() => CreativeAssetSchema.parse({ ...assetImage, sources: ['/abs/dir/'] })).toThrow();
  });

  test('output path es archivo individual: trailing slash rechazado; nombre sin "/"', () => {
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, outputs: [{ ...assetImage.outputs[0], path: 'outputs/covers/' }] }),
    ).toThrow();
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, outputs: [{ ...assetImage.outputs[0], name: 'feed/main' }] }),
    ).toThrow();
  });

  test('asset: nombres y rutas de outputs únicos', () => {
    expect(() =>
      CreativeAssetSchema.parse({
        ...assetImage,
        outputs: [assetImage.outputs[0], { ...assetImage.outputs[1], name: assetImage.outputs[0].name }],
      }),
    ).toThrow(/duplicado/i);
    expect(() =>
      CreativeAssetSchema.parse({
        ...assetImage,
        outputs: [assetImage.outputs[0], { ...assetImage.outputs[1], path: assetImage.outputs[0].path }],
      }),
    ).toThrow(/duplicada/i);
  });

  test('recipe: argv exec-array (nunca sh -c), cwd relativo, outputs declarados en el asset', () => {
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, recipe: { ...assetImage.recipe, argv: 'bun run workroom/render.ts' } }),
    ).toThrow();
    expect(() => CreativeAssetSchema.parse({ ...assetImage, recipe: { ...assetImage.recipe, argv: [] } })).toThrow();
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, recipe: { ...assetImage.recipe, cwd: '/tmp/build' } }),
    ).toThrow();
    expect(() =>
      CreativeAssetSchema.parse({ ...assetImage, recipe: { ...assetImage.recipe, outputs: ['fuera/cover.png'] } }),
    ).toThrow(/externa/i);
    const noRecipeArgs = CreativeAssetSchema.parse({
      ...assetImage,
      recipe: { argv: ['bun', 'run', 'workroom/render.ts'], outputs: ['outputs/cover-feed-v1.png'] },
    });
    expect(noRecipeArgs.recipe?.cwd).toBe('.');
  });

  test('preset version: campos opcionales válidos; recurso con traversal rechazado; clientId formato kebab', () => {
    expect(() => RevisionManifestSchema.parse(buildManifest({ presetSnapshots: [presetB] }))).toThrow(/preset exacto/i);
    expect(() =>
      RevisionManifestSchema.parse(
        buildManifest({
          presetSnapshots: [{ ...presetA, resources: [{ ...presetA.resources[0], path: '../logo.png' }] }, presetB],
        }),
      ),
    ).toThrow();
    expect(() => RevisionManifestSchema.parse(buildManifest({ presetSnapshots: [{ ...presetA, clientId: 'Marca A' }, presetB] }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// RevisionManifest: portable seal
// ---------------------------------------------------------------------------

describe('studio schemas · revision manifest portablo', () => {
  test('ejemplo completo validado (proyecto 2 clientes, asset 2 presets, recipe, 7 files, 2 outputs)', () => {
    const manifest = parseManifest();
    expect(manifest.projectSnapshot.clientIds).toEqual(['marca-a', 'marca-b']);
    expect(manifest.presetSnapshots.map((p) => `${p.presetId}@${p.versionId}`)).toEqual(['preset-a@v001', 'preset-b@v002']);
    expect(manifest.files).toHaveLength(7);
    expect(manifest.outputs).toHaveLength(2);
    expect(manifest.editorialStatus).toBe('draft');
  });

  test('outputs solo apuntan a files existentes y a nombres declarados', () => {
    expect(() => parseManifest({ outputs: [{ name: 'cover-feed-v1', path: 'outputs/inexistente.png' }] })).toThrow(/inexistente/i);
    expect(() => parseManifest({ outputs: [{ name: 'no-declarado', path: 'outputs/cover-feed-v1.png' }] })).toThrow(/no está declarado/i);
    expect(() => parseManifest({ outputs: [] })).toThrow();
  });
  test('outputs del manifest solo referencian files con rol output', () => {
    const sourceRole = files.map((file) => (file.path === 'outputs/cover-feed-v1.png' ? { ...file, role: 'source' as const } : file));
    expect(() => parseManifest({ files: sourceRole })).toThrow(/rol source/);
    const presetRole = files.map((file) => (file.path === 'outputs/cover-feed-preview.jpg' ? { ...file, role: 'preset' as const } : file));
    expect(() => parseManifest({ files: presetRole })).toThrow(/rol preset/);
  });

  test('files: rutas únicas, sha256/bytes válidos, roles del enum', () => {
    expect(() => parseManifest({ files: [...files, files[0]] })).toThrow(/duplicadas/i);
    expect(() => parseManifest({ files: [{ ...files[0], sha256: 'xyz' }] })).toThrow();
    expect(() => parseManifest({ files: [{ ...files[0], bytes: -1 }] })).toThrow();
    expect(() => parseManifest({ files: [{ ...files[0], role: 'config' }] })).toThrow();
  });

  test('snapshots consistentes con projectId/assetId/clientes/presets', () => {
    expect(() => parseManifest({ projectSnapshot: { ...projectTwoClients, id: 'otro-proyecto' } })).toThrow(/no coincide/i);
    expect(() => parseManifest({ assetSnapshot: { ...assetImage, id: 'otro-asset' } })).toThrow(/no coincide/i);
    expect(() => parseManifest({ clientSnapshots: [clientA] })).toThrow(/falta el snapshot del cliente marca-b/i);
    expect(() => parseManifest({ presetSnapshots: [{ ...presetA, versionId: 'v999' }, presetB] })).toThrow(/preset exacto/i);
  });
  test('dueños de presets presentes en clientSnapshots aunque el proyecto no los declare', () => {
    const openProject = parseManifest({ projectSnapshot: { ...projectTwoClients, clientIds: [] } });
    expect(openProject.projectSnapshot.clientIds).toEqual([]);
    expect(openProject.clientSnapshots.map((client) => client.id)).toEqual(['marca-a', 'marca-b']);
    expect(() => parseManifest({ presetSnapshots: [presetA, { ...presetB, clientId: 'marca-c' }] })).toThrow(/marca-c/);
  });

  test('estados editoriales del enum; parentRevisionId opcional kebab', () => {
    expect(parseManifest({ editorialStatus: 'approved' }).editorialStatus).toBe('approved');
    expect(() => parseManifest({ editorialStatus: 'published' })).toThrow();
    expect(parseManifest({ parentRevisionId: 'r000' }).parentRevisionId).toBe('r000');
    expect(() => parseManifest({ parentRevisionId: 'r 000' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SyncReceipt / ProjectCheckpoint
// ---------------------------------------------------------------------------

describe('studio schemas · receipts y checkpoints', () => {
  test('receipt: status local por defecto, confirmed con objetos y error redactado opcional', () => {
    const receipt = SyncReceiptSchema.parse({
      schemaVersion: 1,
      projectId: 'campana-verano',
      assetId: 'cover-feed',
      revisionId: 'r001',
      rootHash: SHA_A,
      manifestKey: 'studio/v1/projects/campana-verano/assets/cover-feed/revisions/r001/manifest.json',
      manifestSha256: SHA_B,
    });
    expect(receipt.status).toBe('local');
    expect(receipt.confirmedObjects).toEqual([]);
    const confirmed = SyncReceiptSchema.parse({
      ...receipt,
      status: 'confirmed',
      confirmedObjects: ['objects/aa/aaaa'],
    });
    expect(confirmed.confirmedObjects).toEqual(['objects/aa/aaaa']);
    const failed = SyncReceiptSchema.parse({
      ...receipt,
      status: 'failed',
      error: { code: 'STORAGE_UNAVAILABLE', message: 'R2 inaccesible (credenciales redactadas)' },
    });
    expect(failed.error?.code).toBe('STORAGE_UNAVAILABLE');
    expect(() => SyncReceiptSchema.parse({ ...receipt, error: { code: 'INTERNAL_CRASH', message: 'x' } })).toThrow();
  });

  test('checkpoint: mapa inmutable assetId→revisión, sin assets duplicados', () => {
    const checkpoint = ProjectCheckpointSchema.parse({
      schemaVersion: 1,
      projectId: 'campana-verano',
      checkpointId: 'checkpoint-2026-09-30',
      createdAt: '2026-09-30T21:00:00.000Z',
      entries: [
        { assetId: 'cover-feed', revisionId: 'r002', rootHash: SHA_A },
        { assetId: 'cover-story', revisionId: 'r001', rootHash: SHA_B },
      ],
    });
    expect(checkpoint.entries).toHaveLength(2);
    expect(() =>
      ProjectCheckpointSchema.parse({
        ...checkpoint,
        entries: [...checkpoint.entries, { assetId: 'cover-feed', revisionId: 'r003', rootHash: SHA_C }],
      }),
    ).toThrow(/una vez/i);
  });
});

// ---------------------------------------------------------------------------
// Frozen catalog DTO (P-005)
// ---------------------------------------------------------------------------

describe('studio schemas · catálogo DTO congelado', () => {
  test('entrada con estados separados editorial/producción/backup y errores estables', () => {
    const entry = StudioCatalogEntrySchema.parse({
      projectId: 'campana-verano',
      assetId: 'cover-feed',
      revisionId: 'r001',
      rootHash: SHA_A,
      project: { id: 'campana-verano', name: 'Campaña Verano' },
      clients: [{ id: 'marca-a', name: 'Marca A' }, { id: 'marca-b', name: 'Marca B' }],
      asset: { id: 'cover-feed', kind: 'image', title: 'Cover feed doble marca', presetRefs: assetImage.presetRefs },
      presets: [
        { presetId: 'preset-a', versionId: 'v001', clientId: 'marca-a', name: 'Marca A 2026' },
        { presetId: 'preset-b', versionId: 'v002', clientId: 'marca-b', name: 'Marca B Fiesta' },
      ],
      outputs: [
        {
          name: 'cover-feed-v1',
          mediaType: 'image/png',
          role: 'deliverable',
          visibility: 'private',
          servicePath: '/api/files/campana-verano/cover-feed/r001/cover-feed-v1',
        },
      ],
      editorialStatus: 'draft',
      production: { presentOutputs: ['cover-feed-v1'], missingOutputs: ['cover-feed-preview'] },
      backup: { status: 'confirmed', receiptVerified: true },
      errors: [],
    });
    expect(entry.production.missingOutputs).toEqual(['cover-feed-preview']);
    expect(() => StudioCatalogEntrySchema.parse({ ...entry, editorialStatus: 'publicado' })).toThrow();
    expect(() => StudioCatalogEntrySchema.parse({ ...entry, backup: { status: 'synced' } })).toThrow();
    expect(() => StudioCatalogEntrySchema.parse({ ...entry, errors: [{ code: 'WOOPS', message: 'x' }] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Canonical JSON + rootHash
// ---------------------------------------------------------------------------

describe('studio domain · canonical json', () => {
  test('claves ordenadas recursivamente, arrays conservan orden, sin whitespace', () => {
    expect(canonicalStudioJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
    expect(canonicalStudioJson({ b: 1, a: [2, 1] })).toBe(canonicalStudioJson({ a: [2, 1], b: 1 }));
    expect(canonicalStudioJson({ x: { z: 1, y: null } })).toBe('{"x":{"y":null,"z":1}}');
  });

  test('strings escapados como JSON; undefined ya no se descarta en silencio', () => {
    expect(canonicalStudioJson({ b: 'x"y' })).toBe('{"b":"x\\"y"}');
    expect(() => canonicalStudioJson({ a: undefined } as unknown as StudioJsonValue)).toThrow(TypeError);
  });

  test('NaN/Infinity rechazados sin colisión con null; bigint, símbolo y función también', () => {
    expect(canonicalStudioJson(null)).toBe('null');
    expect(() => canonicalStudioJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalStudioJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalStudioJson({ x: Number.NaN } as unknown as StudioJsonValue)).toThrow(TypeError);
    expect(() => canonicalStudioJson(10n as unknown as StudioJsonValue)).toThrow(TypeError);
    expect(() => canonicalStudioJson(Symbol('s') as unknown as StudioJsonValue)).toThrow(TypeError);
    expect(() => canonicalStudioJson((() => 1) as unknown as StudioJsonValue)).toThrow(TypeError);
  });

  test('arrays dispersos y objetos no planos rechazados', () => {
    expect(() => canonicalStudioJson([1, , 3] as unknown as StudioJsonValue)).toThrow(TypeError);
    expect(() => canonicalStudioJson(new Map([['k', 1]]) as unknown as StudioJsonValue)).toThrow(TypeError);
    expect(() => canonicalStudioJson(new Date('2026-01-01T00:00:00Z') as unknown as StudioJsonValue)).toThrow(TypeError);
  });

  test('getters rechazados sin ejecutarse (solo descriptores, nunca invocación)', () => {
    let executed = false;
    const withGetter = {
      get secret(): string {
        executed = true;
        return 'boom';
      },
    };
    expect(() => canonicalStudioJson(withGetter as unknown as StudioJsonValue)).toThrow(TypeError);
    expect(executed).toBe(false);
  });

  test('ciclos rechazados con TypeError, sin desbordar la pila', () => {
    const cyclicObject: Record<string, unknown> = { region: 'latam' };
    cyclicObject.self = cyclicObject;
    expect(() => canonicalStudioJson(cyclicObject as unknown as StudioJsonValue)).toThrow(TypeError);
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(() => canonicalStudioJson(cyclicArray as unknown as StudioJsonValue)).toThrow(TypeError);
  });
});

describe('studio domain · rootHash del contenido sellado', () => {
  test('mismo contenido → mismo rootHash aunque cambien ids, timestamp, nota, estado y parent', async () => {
    const first = await computeRevisionRootHash(parseManifest());
    const second = await computeRevisionRootHash(
      parseManifest({
        revisionId: 'r777',
        createdAt: '2030-01-01T00:00:00.000Z',
        note: 're-sellado con otra nota',
        editorialStatus: 'approved',
        parentRevisionId: 'r001',
        rootHash: SHA_C,
      }),
    );
    expect(second).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test('files desordenados → mismo rootHash (payload normaliza por path)', async () => {
    const ordered = await computeRevisionRootHash(parseManifest());
    const shuffled = await computeRevisionRootHash(parseManifest({ files: [...files].reverse() }));
    expect(shuffled).toBe(ordered);
  });

  test('cambio de un output sellado altera rootHash', async () => {
    const base = await computeRevisionRootHash(parseManifest());
    const changed = await computeRevisionRootHash(
      parseManifest({ files: files.map((f) => (f.path === 'outputs/cover-feed-v1.png' ? { ...f, sha256: SHA_G, bytes: 89_000 } : f)) }),
    );
    expect(changed).not.toBe(base);
  });

  test('cambio de un preset altera rootHash; cambio de recipe también', async () => {
    const base = await computeRevisionRootHash(parseManifest());
    const presetChanged = await computeRevisionRootHash(
      parseManifest({
        presetSnapshots: [
          { ...presetA, identity: { ...presetA.identity, palette: ['#ffffff', '#f5f5f5'] } },
          presetB,
        ],
      }),
    );
    expect(presetChanged).not.toBe(base);
    const recipeChanged = await computeRevisionRootHash(parseManifest({ recipeSnapshot: undefined }));
    expect(recipeChanged).not.toBe(base);
  });

  test('campos no sellados excluidos: difiere del hash canónico del manifest completo', async () => {
    const manifest = parseManifest();
    const sealed = await computeRevisionRootHash(manifest);
    const fullDocument = await sha256Hex(canonicalStudioJson(manifest as unknown as StudioJsonValue));
    expect(fullDocument).not.toBe(sealed);
  });

  test('hash canónico independiente del orden de construcción; el naive no lo es', async () => {
    const payload = buildRevisionSealPayload(parseManifest());
    const reordered: typeof payload = {
      outputs: payload.outputs,
      files: payload.files,
      recipeSnapshot: payload.recipeSnapshot,
      presetSnapshots: payload.presetSnapshots,
      assetSnapshot: payload.assetSnapshot,
      clientSnapshots: payload.clientSnapshots,
      projectSnapshot: payload.projectSnapshot,
      schemaVersion: payload.schemaVersion,
    };
    expect(await hashRevisionSealPayload(reordered)).toBe(await hashRevisionSealPayload(payload));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(payload));
  });

  test('buildRevisionSealPayload omite explícitamente los opcionales undefined', () => {
    const withRecipe = buildRevisionSealPayload(parseManifest());
    expect('recipeSnapshot' in withRecipe).toBe(true);
    const withoutRecipe = buildRevisionSealPayload(parseManifest({ recipeSnapshot: undefined }));
    expect('recipeSnapshot' in withoutRecipe).toBe(false);
    expect(Object.keys(withoutRecipe).sort()).toEqual([
      'assetSnapshot',
      'clientSnapshots',
      'files',
      'outputs',
      'presetSnapshots',
      'projectSnapshot',
      'schemaVersion',
    ]);
  });
});
