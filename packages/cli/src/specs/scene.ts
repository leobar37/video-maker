/**
 * Scene delegation command group (FR-014): `scene-brief`, `scene-log`,
 * `scene-verify`.
 *
 * The delegation contract: a curated `SceneBrief` goes out to an external
 * executor (execution itself is external by design — this CLI never runs it),
 * the mandatory `SceneDelegation` journal records who executed what and when,
 * and `scene-verify` checks the resulting `SceneResult` INDEPENDENTLY against
 * the on-disk artifacts (real sha256 evidence, containment, schema
 * consistency). A mismatch always exits non-zero.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import {
  resolveInsideProject,
  sha256File,
  sha256Json,
  type Project,
  type SceneConfig,
} from '@videomaker/core';
import { resolveBrandTokens, type BrandTokens } from '@videomaker/motion-remotion';
import {
  SceneBriefSchema,
  SceneDelegationJournalSchema,
  SceneDelegationSchema,
  SceneResultSchema,
  sanitizeArtifactRelativePath,
  type SceneBrief,
  type SceneDelegation,
  type SceneDelegationJournal,
  type SceneResult,
} from '@videomaker/schemas';

import {
  JSON_ARG,
  PROJECT_ARG,
  pathExists,
  readJsonFile,
  resolveProjectDir,
  writeJsonFile,
} from '../args';
import { loadProjectOrFail } from './inspect';
import type { CommandRunContext, CommandSpec, PlanStep } from '../spec-types';

// ---------------------------------------------------------------------------
// Per-scene file layout (project-relative)
// ---------------------------------------------------------------------------

const BRIEF_TEMPLATE = 'scenes/{sceneId}.brief.json';
const RESULT_TEMPLATE = 'scenes/{sceneId}.result.json';
const DELEGATION_TEMPLATE = 'scenes/{sceneId}.delegation.json';
const AVATAR_CRITIQUE_TEMPLATE = 'scenes/{sceneId}/avatar-critique.json';

/** Fills a `{sceneId}` path template. Used across brief/result/journal paths. */
function scenePath(template: string, sceneId: string): string {
  return template.replace('{sceneId}', sceneId);
}

// ---------------------------------------------------------------------------
// Scene agent registry — routing and curated context per specialization
// ---------------------------------------------------------------------------

export const SCENE_AGENT_IDS = [
  'remotion-scene-designer',
  'playbook-writer',
  'scene-critic',
  'creator-scene-producer',
] as const;
export type SceneAgentId = (typeof SCENE_AGENT_IDS)[number];

interface SceneAgentSpec {
  id: SceneAgentId;
  /** Scene sources this agent authors/reviews. */
  sources: readonly SceneConfig['source'][];
  /** Curated context package (project-relative), the brief always first. */
  contextFiles: string[];
  /** Project-relative artifact path the agent must produce. */
  outputPath: string;
  /** Project-relative validation still path. */
  stillPath: string;
}

const SCENE_AGENTS: Record<SceneAgentId, SceneAgentSpec> = {
  'remotion-scene-designer': {
    id: 'remotion-scene-designer',
    sources: ['motion'],
    contextFiles: ['video.json', 'script/narration.md'],
    outputPath: 'remotion/scenes/{sceneId}.tsx',
    stillPath: 'qa/stills/{sceneId}.png',
  },
  'playbook-writer': {
    id: 'playbook-writer',
    sources: ['demo-app'],
    contextFiles: ['video.json', 'script/narration.md'],
    outputPath: 'scenes/{sceneId}/playbook.yaml',
    stillPath: 'qa/stills/{sceneId}.png',
  },
  'creator-scene-producer': {
    id: 'creator-scene-producer',
    sources: ['avatar'],
    contextFiles: ['video.json', 'script/narration.md'],
    outputPath: 'scenes/{sceneId}/avatar.mp4',
    stillPath: 'qa/stills/{sceneId}.png',
  },
  'scene-critic': {
    id: 'scene-critic',
    sources: ['motion', 'demo-app', 'fal-video', 'avatar'],
    contextFiles: ['video.json'],
    outputPath: 'scenes/{sceneId}/critique.json',
    stillPath: 'qa/stills/{sceneId}.png',
  },
};

/** Authoring agent per scene source; fal-video scenes are generated, not authored. */
function defaultAgentForSource(source: SceneConfig['source']): SceneAgentId {
  if (source === 'motion') return 'remotion-scene-designer';
  if (source === 'demo-app') return 'playbook-writer';
  if (source === 'avatar') return 'creator-scene-producer';
  throw new Error(
    'Las escenas fal-video no tienen agente de autoría: se generan con los verbos de media. ' +
      'Para revisarlas delegá explícitamente a --agent scene-critic.',
  );
}

// ---------------------------------------------------------------------------
// Branding resolution (preset tokens; neutral fallback keeps everything offline)
// ---------------------------------------------------------------------------

interface SceneBrandingShape {
  canvasFrom: string;
  canvasTo: string;
  ink: string;
  accent: string;
  fontDisplay: string;
  fontBody: string;
}

/**
 * Generic placeholder tokens — never invented brand identity. Real presets
 * resolve from the shared brand-token registry when it is installed.
 */
const NEUTRAL_BRANDING: SceneBrandingShape = {
  canvasFrom: '#FBF9F6',
  canvasTo: '#F1ECE4',
  ink: '#1C1917',
  accent: '#8A8A8A',
  fontDisplay: 'sans-serif',
  fontBody: 'sans-serif',
};

function resolveSceneBranding(preset: string): SceneBrandingShape {
  try {
    const tokens: BrandTokens = resolveBrandTokens(preset);
    return {
      canvasFrom: tokens.canvas.from,
      canvasTo: tokens.canvas.to,
      ink: tokens.ink,
      accent: tokens.accent,
      fontDisplay: tokens.fontDisplay,
      fontBody: tokens.fontBody,
    };
  } catch {
    // Unknown preset: stay offline with neutrals; `brandingPreset` in the brief
    // remains authoritative for the executor.
    return NEUTRAL_BRANDING;
  }
}

// ---------------------------------------------------------------------------
// SceneBrief builder
// ---------------------------------------------------------------------------

interface BriefInput {
  project: Project;
  sceneId: string;
  agent: SceneAgentId;
  isBranded: boolean;
  /** Raw `video.json` payload (to read extras the runtime contract ignores). */
  rawConfig: Record<string, unknown>;
}

function sceneDurationSeconds(scene: SceneConfig, avatarBinding: AvatarBinding | undefined): number {
  if (scene.source === 'avatar' && avatarBinding) {
    return (avatarBinding.endFrame - avatarBinding.startFrame) / avatarBinding.fps;
  }
  return scene.durationHint ?? 5;
}

interface AvatarBinding {
  startFrame: number;
  endFrame: number;
  fps: number;
  [key: string]: unknown;
}

/** Raw per-scene extras (e.g. avatar.audioBinding) survive project validation. */
function rawScene(config: Record<string, unknown>, sceneId: string): Record<string, unknown> {
  const scenes = config.scenes;
  if (!Array.isArray(scenes)) return {};
  const entry = scenes.find(
    (item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === sceneId,
  );
  return typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
}

function avatarBindingOf(raw: Record<string, unknown>): AvatarBinding | undefined {
  const avatar = raw.avatar;
  if (typeof avatar !== 'object' || avatar === null) return undefined;
  const binding = (avatar as { audioBinding?: unknown }).audioBinding;
  if (typeof binding !== 'object' || binding === null) return undefined;
  return binding as AvatarBinding;
}

function buildSceneBrief(input: BriefInput): SceneBrief {
  const { project, sceneId, agent } = input;
  const spec = SCENE_AGENTS[agent];
  const scene = project.config.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new Error(
      `La escena "${sceneId}" no existe en ${project.dir}/video.json ` +
        `(escenas: ${project.config.scenes.map((entry) => entry.id).join(', ')}).`,
    );
  }
  if (!spec.sources.includes(scene.source)) {
    throw new Error(
      `El agente "${agent}" no atiende escenas de tipo "${scene.source}" (soporta: ${spec.sources.join(', ')}).`,
    );
  }
  if (scene.status !== 'active') {
    throw new Error(
      `La escena "${sceneId}" está "${scene.status}": completá su definición en video.json antes de delegarla.`,
    );
  }

  const raw = rawScene(input.rawConfig, sceneId);
  const binding = avatarBindingOf(raw);
  if (scene.source === 'avatar' && !binding) {
    throw new Error(
      `La escena "${sceneId}" es avatar: falta avatar.audioBinding en video.json ` +
        '(producí la narración continua primero).',
    );
  }

  const active = project.config.scenes.filter((entry) => entry.status === 'active');
  const index = active.findIndex((entry) => entry.id === scene.id);
  const neighbor = (entry: SceneConfig | undefined) =>
    entry
      ? {
          id: entry.id,
          intent: entry.intent,
          narration: entry.narration,
          source: entry.source,
          durationSeconds: sceneDurationSeconds(entry, avatarBindingOf(rawScene(input.rawConfig, entry.id))),
        }
      : undefined;

  const briefPath = scenePath(BRIEF_TEMPLATE, sceneId);
  const branding = resolveSceneBranding(project.config.branding.preset);
  const avatar = scene.avatar;

  return SceneBriefSchema.parse({
    sceneId,
    agent,
    videoDir: project.slug,
    intent: scene.intent,
    narration: scene.narration,
    durationSeconds: sceneDurationSeconds(scene, binding),
    brandingPreset: project.config.branding.preset,
    branding,
    isBranded: input.isBranded,
    source: scene.source,
    outputPath: scenePath(spec.outputPath, sceneId),
    stillPath: scenePath(spec.stillPath, sceneId),
    contextFiles: [briefPath, ...spec.contextFiles],
    globalDirection: {
      title: project.config.title,
      ...(project.config.visualSystem?.styleReference !== undefined
        ? { styleReference: project.config.visualSystem.styleReference }
        : {}),
      ...(project.config.visualSystem?.cameraLanguage !== undefined
        ? { cameraLanguage: project.config.visualSystem.cameraLanguage }
        : {}),
    },
    neighbors: { previous: neighbor(active[index - 1]), next: neighbor(active[index + 1]) },
    ...(scene.source === 'avatar' && avatar
      ? {
          avatar: {
            image: avatar.image,
            audio: avatar.audio,
            audioBinding: binding,
            ...(avatar.characterRefs !== undefined ? { characterRefs: avatar.characterRefs } : {}),
            ...(avatar.productReferences !== undefined
              ? { productReferences: avatar.productReferences }
              : {}),
          },
          identityReferences: (project.config.visualSystem?.characters ?? []).filter((character) =>
            (avatar.characterRefs ?? []).includes(character.id),
          ),
          productReferencePaths: avatar.productReferences ?? [avatar.image],
          avatarCritiquePath: scenePath(AVATAR_CRITIQUE_TEMPLATE, sceneId),
        }
      : {}),
    ...(scene.falVideo
      ? {
          authorizedOperations: [
            {
              subject: `fal-video:${sceneId}`,
              command: 'gen-media',
              digest: sha256Json({ sceneId, preset: scene.falVideo.preset, duration: scene.falVideo.duration }),
              budgetUsd: scene.falVideo.budgetUsd,
              maxAttempts: scene.falVideo.maxAttempts,
            },
          ],
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// scene-verify — independent evidence verification
// ---------------------------------------------------------------------------

interface VerifyOutcome {
  ok: boolean;
  errors: string[];
  result?: SceneResult;
}

async function verifySceneResult(projectDir: string, brief: SceneBrief, raw: unknown): Promise<VerifyOutcome> {
  const errors: string[] = [];
  const withoutNulls = Object.fromEntries(
    Object.entries((raw ?? {}) as Record<string, unknown>).filter(([, value]) => value !== null),
  );
  const parsed = SceneResultSchema.safeParse(withoutNulls);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `SceneResult inválido — ${issue.path.join('.') || '(raíz)'}: ${issue.message}`,
      ),
    };
  }
  const result = parsed.data;
  if (result.sceneId !== brief.sceneId) errors.push(`sceneId no coincide: ${result.sceneId} ≠ ${brief.sceneId}.`);
  if (result.agent !== brief.agent) errors.push(`agent no coincide: ${result.agent} ≠ ${brief.agent}.`);
  if (result.executionStatus !== 'ok') {
    errors.push(`la ejecución no terminó en "ok" (executionStatus: ${result.executionStatus}).`);
    return { ok: false, errors, result };
  }

  const checkFile = async (relative: string, expected: string | undefined, label: string): Promise<void> => {
    try {
      // Throws on traversal/absolute/Windows separators (anti-traversal by design).
      sanitizeArtifactRelativePath(relative);
    } catch (error) {
      errors.push(`${label}: ruta de evidencia insegura (${error instanceof Error ? error.message : String(error)}).`);
      return;
    }
    let absolute: string;
    try {
      absolute = await resolveInsideProject(projectDir, ...relative.split('/'));
    } catch {
      errors.push(`${label}: la evidencia escapa del proyecto (${relative}).`);
      return;
    }
    if (!(await pathExists(absolute))) {
      errors.push(`${label}: no existe la evidencia ${relative}.`);
      return;
    }
    if (expected !== undefined) {
      const actual = await sha256File(absolute);
      if (actual !== expected) errors.push(`${label}: SHA-256 no coincide para ${relative}.`);
    }
  };

  if (result.outputPath !== brief.outputPath) {
    errors.push(`outputPath no corresponde al brief (esperado ${brief.outputPath}).`);
  }
  await checkFile(result.outputPath ?? brief.outputPath, result.outputSha256, 'output');
  for (const artifact of result.artifacts ?? []) {
    await checkFile(artifact.path, artifact.sha256, `artifact ${artifact.path}`);
  }
  if (result.stillPath) {
    if (result.stillPath !== brief.stillPath) {
      errors.push(`stillPath no corresponde al brief (esperado ${brief.stillPath}).`);
    }
    await checkFile(result.stillPath, result.stillSha256, 'still');
  }
  const hasErrorDiagnostics = result.diagnostics.some((item) => item.level === 'error');
  if (hasErrorDiagnostics && result.editorialVerdict === 'pass') {
    errors.push('editorialVerdict "pass" es inconsistente con diagnósticos de error.');
  }
  return { ok: errors.length === 0, errors, result };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

function resolveScene(ctx: CommandRunContext): string {
  const value = ctx.args.scene;
  if (typeof value !== 'string' || value.trim() === '') return ctx.fail('Falta --scene <sceneId>.');
  return value;
}

export const sceneSpecs: CommandSpec[] = [
  {
    verb: 'scene-brief',
    summary: 'Emite el SceneBrief JSON de una escena para delegarla a un ejecutor externo (FR-014).',
    args: [
      PROJECT_ARG,
      { name: 'scene', kind: 'string', required: true, description: 'Id de la escena a delegar.' },
      { name: 'agent', kind: 'string', required: false, default: '', description: 'Agente ejecutor (default: por tipo de escena).' },
      { name: 'branded', kind: 'boolean', required: false, default: true, description: 'La escena muestra marca de canal/producto.' },
      JSON_ARG,
    ],
    supportsPlan: true,
    writes: ['scenes/<sceneId>.brief.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      return [
        {
          action: `construir SceneBrief para la escena ${String(ctx.args.scene)}`,
          writes: scenePath(BRIEF_TEMPLATE, String(ctx.args.scene)),
        },
      ];
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const project = await loadProjectOrFail(projectDir, ctx.fail);
      const sceneId = resolveScene(ctx);
      const agentArg = typeof ctx.args.agent === 'string' && ctx.args.agent !== '' ? ctx.args.agent : undefined;
      const scene = project.config.scenes.find((entry) => entry.id === sceneId);
      let agent: SceneAgentId;
      try {
        agent = (agentArg ?? defaultAgentForSource(scene?.source ?? 'motion')) as SceneAgentId;
      } catch (error) {
        return ctx.fail(error instanceof Error ? error.message : String(error));
      }
      if (!(SCENE_AGENT_IDS as readonly string[]).includes(agent)) {
        return ctx.fail(`Agente desconocido "${agent}". Válidos: ${SCENE_AGENT_IDS.join(', ')}.`);
      }
      let brief: SceneBrief;
      try {
        brief = buildSceneBrief({
          project,
          sceneId,
          agent,
          isBranded: ctx.args.branded !== false,
          rawConfig: (await readJsonFile(join(projectDir, 'video.json'))) as Record<string, unknown>,
        });
      } catch (error) {
        return ctx.fail(error instanceof Error ? error.message : String(error));
      }
      const relative = scenePath(BRIEF_TEMPLATE, sceneId);
      const absolute = await resolveInsideProject(projectDir, 'scenes', `${sceneId}.brief.json`);
      await writeJsonFile(absolute, brief);
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify({ brief, path: relative, agent }, null, 2));
      } else {
        ctx.out(`brief escrito en ${relative} (agente: ${agent}).`);
        ctx.out('  Ejecutá la escena fuera de este CLI y registrá el rastro con `vm scene-log --action record ...`.');
      }
      return { exitCode: 0 };
    },
  },
  {
    verb: 'scene-log',
    summary: 'Journal de delegación de escenas: quién ejecutó qué, cuándo y con qué brief (append-only).',
    args: [
      { name: 'action', kind: 'string', required: true, description: 'record | list.' },
      PROJECT_ARG,
      { name: 'scene', kind: 'string', required: false, default: '', description: 'Id de la escena (requerido para record).' },
      { name: 'agent', kind: 'string', required: false, default: '', description: 'Agente ejecutor (requerido para record).' },
      { name: 'agent-id', kind: 'string', required: false, default: '', description: 'Id de tarea del ejecutor (requerido para record).' },
      { name: 'history', kind: 'string', required: false, default: '', description: 'Referencia history:// del transcript (requerido para record).' },
      { name: 'started-at', kind: 'string', required: false, default: '', description: 'ISO-8601 inicio de la ejecución (requerido para record).' },
      { name: 'outcome', kind: 'string', required: false, default: '', description: 'running|ok|fail|waiting-human (requerido para record).' },
      { name: 'ended-at', kind: 'string', required: false, default: '', description: 'ISO-8601 fin de la ejecución.' },
      { name: 'model', kind: 'string', required: false, default: '', description: 'Modelo usado por el ejecutor.' },
      { name: 'workspace', kind: 'string', required: false, default: '', description: 'Referencia del workspace del ejecutor.' },
      { name: 'result-ref', kind: 'string', required: false, default: '', description: 'Referencia al SceneResult escrito.' },
      JSON_ARG,
    ],
    supportsPlan: true,
    writes: ['scenes/<sceneId>.delegation.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const action = String(ctx.args.action);
      if (action === 'list') return [{ action: 'leer los journals de delegación (solo lectura)' }];
      return [
        {
          action: `append de delegación para la escena ${String(ctx.args.scene)}`,
          writes: scenePath(DELEGATION_TEMPLATE, String(ctx.args.scene)),
        },
      ];
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const action = String(ctx.args.action);
      const asJson = ctx.args.json === true;
      const project = await loadProjectOrFail(projectDir, ctx.fail);

      if (action === 'list') {
        const sceneFilter = typeof ctx.args.scene === 'string' && ctx.args.scene !== '' ? ctx.args.scene : undefined;
        const entries: SceneDelegation[] = [];
        for (const scene of project.config.scenes) {
          if (sceneFilter !== undefined && scene.id !== sceneFilter) continue;
          const path = await resolveInsideProject(projectDir, 'scenes', `${scene.id}.delegation.json`);
          if (!(await pathExists(path))) continue;
          const journal = SceneDelegationJournalSchema.parse(await readJsonFile(path));
          entries.push(...journal.entries);
        }
        if (asJson) {
          ctx.out(JSON.stringify(entries, null, 2));
        } else if (entries.length === 0) {
          ctx.out('sin delegaciones registradas para este proyecto.');
        } else {
          for (const entry of entries) {
            ctx.out(
              `  ${entry.sceneId.padEnd(16)} ${entry.agent.padEnd(26)} ${entry.outcome.padEnd(13)} ` +
                `${entry.agentId} · ${entry.historyRef} · brief ${entry.briefDigest.slice(0, 12)}`,
            );
          }
        }
        return { exitCode: 0 };
      }

      if (action !== 'record') ctx.fail(`--action inválido "${action}" (record|list).`);
      for (const [flag, value] of Object.entries({
        scene: String(ctx.args.scene ?? ''),
        agent: String(ctx.args.agent ?? ''),
        'agent-id': String(ctx.args['agent-id'] ?? ''),
        history: String(ctx.args.history ?? ''),
        'started-at': String(ctx.args['started-at'] ?? ''),
        outcome: String(ctx.args.outcome ?? ''),
      })) {
        if (value === '') ctx.fail(`scene-log record requiere --${flag}.`);
      }
      const outcome = String(ctx.args.outcome);
      if (!['running', 'ok', 'fail', 'waiting-human'].includes(outcome)) {
        ctx.fail(`--outcome inválido "${outcome}" (running|ok|fail|waiting-human).`);
      }
      for (const flag of ['started-at', 'ended-at'] as const) {
        const value = String(ctx.args[flag] ?? '');
        if (value !== '' && Number.isNaN(Date.parse(value))) {
          ctx.fail(`--${flag} debe ser una fecha ISO-8601 válida.`);
        }
      }
      const sceneId = String(ctx.args.scene);
      const briefRelative = scenePath(BRIEF_TEMPLATE, sceneId);
      const briefAbsolute = await resolveInsideProject(projectDir, 'scenes', `${sceneId}.brief.json`);
      if (!(await pathExists(briefAbsolute))) {
        ctx.fail(`Falta el brief ${briefRelative}: generá el brief primero (\`vm scene-brief --scene ${sceneId}\`).`);
      }
      const entry = SceneDelegationSchema.parse({
        schemaVersion: 1,
        sceneId,
        agent: String(ctx.args.agent),
        agentId: String(ctx.args['agent-id']),
        historyRef: String(ctx.args.history),
        ...(String(ctx.args.model) !== '' ? { model: String(ctx.args.model) } : {}),
        ...(String(ctx.args.workspace) !== '' ? { workspaceRef: String(ctx.args.workspace) } : {}),
        briefPath: briefRelative,
        briefDigest: await sha256File(briefAbsolute),
        startedAt: String(ctx.args['started-at']),
        ...(String(ctx.args['ended-at']) !== '' ? { endedAt: String(ctx.args['ended-at']) } : {}),
        outcome: outcome as SceneDelegation['outcome'],
        ...(String(ctx.args['result-ref']) !== '' ? { resultRef: String(ctx.args['result-ref']) } : {}),
      });
      const journalAbsolute = await resolveInsideProject(projectDir, 'scenes', `${sceneId}.delegation.json`);
      const journal: SceneDelegationJournal = (await pathExists(journalAbsolute))
        ? SceneDelegationJournalSchema.parse(await readJsonFile(journalAbsolute))
        : { schemaVersion: 1, sceneId, entries: [] as SceneDelegation[] };
      journal.entries.push(entry);
      await writeJsonFile(journalAbsolute, journal);
      if (asJson) {
        ctx.out(JSON.stringify(entry, null, 2));
      } else {
        ctx.out(`delegación registrada: ${entry.sceneId} → ${entry.agent} (${entry.agentId}, ${entry.historyRef}).`);
      }
      return { exitCode: 0 };
    },
  },
  {
    verb: 'scene-verify',
    summary: 'Verificación independiente de un SceneResult contra la evidencia en disco (sha256, rutas, esquema).',
    args: [
      PROJECT_ARG,
      { name: 'scene', kind: 'string', required: true, description: 'Id de la escena a verificar.' },
      JSON_ARG,
    ],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(ctx): PlanStep[] {
      return [{ action: `verificar SceneResult de ${String(ctx.args.scene)} contra artefactos en disco (solo lectura)` }];
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const sceneId = resolveScene(ctx);
      const briefAbsolute = await resolveInsideProject(projectDir, 'scenes', `${sceneId}.brief.json`);
      const resultAbsolute = await resolveInsideProject(projectDir, 'scenes', `${sceneId}.result.json`);
      if (!(await pathExists(briefAbsolute))) {
        ctx.fail(`Falta el brief: ${scenePath(BRIEF_TEMPLATE, sceneId)}.`);
      }
      if (!(await pathExists(resultAbsolute))) {
        ctx.fail(`Falta el resultado: ${scenePath(RESULT_TEMPLATE, sceneId)}.`);
      }
      const brief = SceneBriefSchema.parse(await readJsonFile(briefAbsolute));
      const raw = (await readJsonFile(resultAbsolute)) as unknown;
      const outcome = await verifySceneResult(projectDir, brief, raw);
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify({ ok: outcome.ok, errors: outcome.errors, result: outcome.result ?? null }, null, 2));
      } else if (outcome.ok) {
        const result = outcome.result!;
        ctx.out(
          `verificado ${sceneId}: ${result.executionStatus}/${result.editorialVerdict}` +
            (result.outputPath ? ` → ${result.outputPath}` : ''),
        );
        for (const diagnostic of result.diagnostics) ctx.out(`  ${diagnostic.level} ${diagnostic.message}`);
      } else {
        for (const error of outcome.errors) ctx.out(`✗ ${error}`);
      }
      return { exitCode: outcome.ok ? 0 : 1 };
    },
  },
];
