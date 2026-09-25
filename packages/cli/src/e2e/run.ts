/**
 * `demo:e2e` driver: one reproducible end-to-end run of the pipeline over the
 * demo project, in `live` or `offline` mode.
 *
 * Order (both modes): plan costs → enforce the explicit spend cap →
 * narration master (real TTS or local synth) → music bed (library reuse
 * first; paid generation only with `--allow-music-provider` + cap headroom) →
 * assemble (render → ducking → loudnorm/ebur128) → qa + evidence → publish
 * `--dry-run` (plan mode: never a publisher call) → post-run self-checks
 * (secret grep, ffprobe, loudness, journal) → `qa/metrics.json` + report.
 *
 * Invariants: every spend goes through the core paid-operation engine with a
 * receipt in `qa/spend.json`; cumulative journalled spend is checked against
 * the cap BEFORE each submit; receipt-less failures stay `uncertain`,
 * documented and never retried; no secret value is ever printed (redacted
 * reporting via `@videomaker/credentials`).
 */
import { resolve } from 'node:path';

import { loadProject, type Project } from '@videomaker/core';
import { credentialReport } from '@videomaker/credentials';
import { listMusicBeds } from '@videomaker/providers';

import { runCli } from '../runtime';
import type { MediaCommandDeps } from '../pipeline/deps';
import {
  MUSIC_AUDIO_RELATIVE,
  MUSIC_META_RELATIVE,
  NARRATION_META_RELATIVE,
  NARRATION_WAV_RELATIVE,
  runGenAudio,
  runGenMusic,
} from '../pipeline/generate';
import { joinSceneNarration, narrationFingerprint } from '../pipeline/narration';
import { runAssemble } from '../pipeline/assemble';
import { runQa } from '../pipeline/qa';
import { readLoudnessReport, writeJsonArtifact } from '../pipeline/evidence';

import { E2E_USAGE, type E2eArgs, E2eUsageError, parseE2eArgs } from './args';
import {
  MUSIC_PLANNED_USD_PER_TRACK,
  SpendCapRefusal,
  assertSpendHeadroom,
  buildSpendPlan,
  decideMusicSource,
  enforceSpendCap,
  formatCostTable,
  type PlannedOperation,
  type SpendPlan,
} from './costs';
import {
  findNarrationMaster,
  isOfflineNarrationMeta,
  writeOfflineNarrationMaster,
} from './offline-narration';
import { DEMO_BED_ID, demoMusicLibraryPaths, ensureDemoMusicBed } from './music-bed';
import { journalOfflineOperation, readJournalSummary, type JournalSummary } from './journal';
import { ensureSceneCaptures } from './captures';
import { formatSecretFindings, scanProjectSecrets } from './secret-scan';
import {
  journalStateCheck,
  loudnessToleranceCheck,
  probeRenderArtifact,
  repinLoudnessEvidence,
} from './checks';
import {
  buildMetricsReport,
  formatMetricsReport,
  type E2eCheck,
  type MetricsLoudness,
  type MetricsReport,
} from './metrics';
import { buildDemoMediaDeps } from './wiring';

/** Project-relative final report of the run. */
export const METRICS_RELATIVE = 'qa/metrics.json';

export interface RunE2eOptions {
  /** Raw driver argv (after `bun run demo:e2e --`). */
  argv: readonly string[];
  /** Working directory the invocation resolves `--project` against. */
  cwd: string;
  out: (line: string) => void;
  /** Test seam: replaces the production deps (music library wiring still applies). */
  deps?: MediaCommandDeps;
  now?: () => Date;
}

export interface RunE2eResult {
  exitCode: number;
  metricsPath?: string;
  report?: MetricsReport;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function estimateOf(plan: SpendPlan, command: string): PlannedOperation | undefined {
  return plan.operations.find((operation) => operation.command === command);
}

/**
 * Runs the whole pipeline. Exit codes: 0 all checks passed; 1 a step/check
 * failed (detail printed); 2 usage or spend-cap refusal (nothing was spent).
 */
export async function runE2e(options: RunE2eOptions): Promise<RunE2eResult> {
  const out = options.out;
  const now = options.now ?? (() => new Date());

  let args: E2eArgs;
  try {
    args = parseE2eArgs(options.argv);
  } catch (error) {
    out(error instanceof E2eUsageError ? error.message : `e2e: ${errorText(error)}`);
    return { exitCode: 2 };
  }

  const projectDir = resolve(options.cwd, args.project);
  let project: Project;
  try {
    project = await loadProject(projectDir);
  } catch (error) {
    out(`e2e: invalid project at ${args.project}: ${errorText(error)}`);
    return { exitCode: 1 };
  }
  out(`e2e: ${args.mode} run of "${project.config.id}" (${project.slug}) in ${args.project}`);

  const baseDeps = options.deps ?? buildDemoMediaDeps(projectDir, out);
  const deps: MediaCommandDeps = {
    ...baseDeps,
    musicLibrary: () => demoMusicLibraryPaths(projectDir),
  };

  const checks: E2eCheck[] = [];
  try {
    // ---- planned costs + spend cap (printed BEFORE anything can submit) ----
    const activeScenes = project.config.scenes.filter((scene) => scene.status === 'active');
    const joined = joinSceneNarration(
      activeScenes.map((scene) => ({ id: scene.id, narration: scene.narration })),
    );
    const fingerprint = narrationFingerprint(project.config.tts, joined.text);
    const existingMaster = await findNarrationMaster(projectDir, fingerprint);
    const narrationWillSubmit =
      existingMaster === undefined ||
      (args.mode === 'live'
        ? isOfflineNarrationMeta(existingMaster)
        : !isOfflineNarrationMeta(existingMaster));

    const bedState = await ensureDemoMusicBed(projectDir, { now, out });
    const journalBefore = await readJournalSummary(projectDir);
    const music = decideMusicSource({
      libraryBeds: listMusicBeds(demoMusicLibraryPaths(projectDir)).map((bed) => bed.id),
      allowMusicProvider: args.allowMusicProvider,
      spendCapHeadroomUsd: (args.spendCapUsd ?? 0) - journalBefore.totalReservedUsd,
      preferredBed: DEMO_BED_ID,
    });
    const plan = buildSpendPlan({
      mode: args.mode,
      narrationChars: joined.text.length,
      narrationWillSubmit,
      music,
    });
    for (const line of formatCostTable(plan, args.spendCapUsd)) out(line);
    try {
      enforceSpendCap(plan, args.spendCapUsd);
    } catch (refusal) {
      if (refusal instanceof SpendCapRefusal) {
        out(`e2e: ${refusal.message}`);
        return { exitCode: 2 };
      }
      throw refusal;
    }

    // ---- narration master: real TTS (live) or local synth (offline) ----
    if (args.mode === 'offline') {
      await writeOfflineNarrationMaster({
        projectDir,
        tts: project.config.tts,
        scenes: activeScenes.map((scene) => ({ id: scene.id, narration: scene.narration })),
        now,
        out,
        force: existingMaster !== undefined && !isOfflineNarrationMeta(existingMaster),
      });
      await journalOfflineOperation(projectDir, {
        command: 'gen-audio',
        subject: `gen-audio:${fingerprint.slice(0, 16)}`,
        inputs: { fingerprint, mode: 'offline' },
        outputs: [NARRATION_WAV_RELATIVE, NARRATION_META_RELATIVE],
        now,
      });
    } else {
      const narrationOp = estimateOf(plan, 'gen-audio');
      if (narrationOp?.paid === true) {
        const journal = await readJournalSummary(projectDir);
        assertSpendHeadroom(journal.totalReservedUsd, narrationOp.estimatedCostUsd, args.spendCapUsd);
      }
      await runGenAudio({
        projectDir,
        deps,
        spendCapUsd: args.spendCapUsd ?? 0,
        estimatedCostUsd: narrationOp !== undefined && narrationOp.estimatedCostUsd > 0
          ? narrationOp.estimatedCostUsd
          : null,
        force: isOfflineNarrationMeta(existingMaster),
        now,
        out,
      });
    }

    // ---- music bed: library reuse first; paid only with explicit opt-in ----
    if (music.kind === 'reuse') {
      await runGenMusic({
        projectDir,
        deps,
        spendCapUsd: args.spendCapUsd ?? 0,
        estimatedCostUsd: null,
        force: true,
        now,
        out,
        generate: false,
        use: music.bedRef,
      });
      if (args.mode === 'offline') {
        await journalOfflineOperation(projectDir, {
          command: 'gen-music',
          subject: `gen-music:${music.bedRef}`,
          inputs: { bedRef: music.bedRef, mode: 'offline' },
          outputs: [MUSIC_AUDIO_RELATIVE, MUSIC_META_RELATIVE],
          now,
        });
      }
    } else if (music.kind === 'generate') {
      const musicOp = estimateOf(plan, 'gen-music');
      const journal = await readJournalSummary(projectDir);
      assertSpendHeadroom(
        journal.totalReservedUsd,
        musicOp?.estimatedCostUsd ?? MUSIC_PLANNED_USD_PER_TRACK,
        args.spendCapUsd,
      );
      await runGenMusic({
        projectDir,
        deps,
        spendCapUsd: args.spendCapUsd ?? 0,
        estimatedCostUsd: musicOp?.estimatedCostUsd ?? MUSIC_PLANNED_USD_PER_TRACK,
        force: false,
        now,
        out,
        generate: true,
        provider: music.provider,
        prompt: 'Calm instrumental bed for a product demo: soft pad, slow, no vocals.',
        lengthSeconds: 24,
      });
    } else {
      out(`gen-music: ${music.detail}`);
    }

    // ---- scene media (local captures) + assemble + qa ----
    await ensureSceneCaptures(project, deps, out);
    const renderStart = now();
    const assembled = await runAssemble({
      projectDir,
      deps,
      outDir: 'renders',
      loudness: true,
      now,
      out,
    });
    const renderEnd = now();

    const qaResult = await runQa({ projectDir, deps, now, out });
    checks.push({
      code: 'qa-verification',
      label: 'Evidence verification (hashes + loudness re-measure) passed',
      status: qaResult.exitCode === 0 ? 'pass' : 'fail',
      detail:
        qaResult.exitCode === 0
          ? `${qaResult.checks.length} check(s) verified against ${qaResult.reportPath}.`
          : qaResult.failures.join('; '),
    });
    await repinLoudnessEvidence(projectDir);

    // ---- publish in plan mode only (no publisher call, no spend) ----
    const publishExit = await runCli(
      [
        'publish',
        '--dry-run',
        '--project',
        projectDir,
        '--account',
        'demo-e2e',
        '--text',
        project.config.title,
        '--idempotency-key',
        `publish:demo-e2e:${project.config.id}`,
      ],
      { cwd: options.cwd, out },
    );
    checks.push({
      code: 'publish-dry-run',
      label: 'Publication planned in dry-run mode (nothing was published)',
      status: publishExit === 0 ? 'pass' : 'fail',
      detail:
        publishExit === 0
          ? 'plan mode only: no publisher call, no credentials resolved (NFR-002).'
          : `vm publish --dry-run exited ${publishExit}.`,
    });

    // ---- post-run self-checks ----
    const probe = await probeRenderArtifact(deps, projectDir, assembled.mp4);
    checks.push(probe.check);
    let loudness: MetricsLoudness | null = null;
    try {
      const loudnessReport = await readLoudnessReport(projectDir);
      const verdict = loudnessToleranceCheck(loudnessReport);
      checks.push(verdict.check);
      loudness = verdict.metrics;
    } catch (error) {
      checks.push({
        code: 'loudness-tolerance',
        label: 'Loudness within tolerance per qa/loudness.json',
        status: 'fail',
        detail: `qa/loudness.json unreadable: ${errorText(error)}`,
      });
    }
    const journal: JournalSummary = await readJournalSummary(projectDir);
    checks.push(journalStateCheck(journal));

    const scanBeforeMetrics = await scanProjectSecrets(projectDir);
    checks.push({
      code: 'secret-grep',
      label: 'No plausible secrets in qa/, journals, project JSON or bundles',
      status: scanBeforeMetrics.ok ? 'pass' : 'fail',
      detail: scanBeforeMetrics.ok
        ? `${scanBeforeMetrics.files.length} artifact file(s) scanned; nothing found.`
        : `secret-like assignments found:\n${formatSecretFindings(scanBeforeMetrics.findings).join('\n')}`,
    });

    // ---- live credential summary (redacted; names + presence + length only) ----
    if (args.mode === 'live') {
      try {
        const entries = await credentialReport({ mode: 'run' });
        out('credentials (redacted report; values are never printed):');
        for (const entry of entries) {
          out(`  ${entry.name}: ${entry.present ? `present (length ${entry.length})` : 'missing'}`);
        }
      } catch (error) {
        out(`credentials: redacted report unavailable (${errorText(error)})`);
      }
    }

    // ---- final report + metrics artifact ----
    const journalAfter = await readJournalSummary(projectDir);
    const report = buildMetricsReport({
      createdAt: now().toISOString(),
      mode: args.mode,
      project: args.project,
      video: {
        id: project.config.id,
        mp4: assembled.mp4,
        sha256: assembled.sha256,
        durationSeconds: probe.durationSeconds > 0 ? probe.durationSeconds : assembled.durationSeconds,
        bytes: probe.bytes,
      },
      render: {
        startedAt: renderStart.toISOString(),
        endedAt: renderEnd.toISOString(),
        renderTimeSeconds: Math.max(0, (renderEnd.getTime() - renderStart.getTime()) / 1000),
        totalFrames: assembled.totalFrames,
        fps: assembled.props.fps,
      },
      spendCapUsd: args.spendCapUsd ?? null,
      plannedUsd: plan.paidTotalUsd,
      journal: journalAfter,
      loudness,
      checks,
    });
    const metricsPath = await writeJsonArtifact(resolve(projectDir, METRICS_RELATIVE), report);
    for (const line of formatMetricsReport(report)) out(line);
    out(`e2e: metrics written to ${METRICS_RELATIVE}`);

    // ---- final secret scan INCLUDES the metrics artifact ----
    const finalScan = await scanProjectSecrets(projectDir);
    if (!finalScan.ok) {
      out('e2e: FAIL — secret-like assignments in the final artifacts (values redacted):');
      for (const line of formatSecretFindings(finalScan.findings)) out(line);
      return { exitCode: 1, metricsPath: METRICS_RELATIVE, report };
    }
    if (!report.passed) {
      out('e2e: FAIL — see the checks above (each detail names the offending artifact).');
      return { exitCode: 1, metricsPath: METRICS_RELATIVE, report };
    }
    out('e2e: OK — render verified, loudness in tolerance, journal clean, publish stays dry-run.');
    return { exitCode: 0, metricsPath: METRICS_RELATIVE, report };
  } catch (error) {
    out(`e2e: ${errorText(error)}`);
    // Document whatever the journal holds — uncertain attempts are never retried.
    try {
      const journal = await readJournalSummary(projectDir);
      if (journal.entries.length > 0) {
        out(
          `e2e: journal state — completed ${journal.counts.completed}, ` +
            `submitted ${journal.counts.submitted}, uncertain ${journal.counts.uncertain}; ` +
            'unresolved attempts stay documented in qa/spend.json and must be reconciled.',
        );
      }
    } catch {
      // No readable journal: nothing to document beyond the failure itself.
    }
    return { exitCode: 1 };
  }
}

export { E2E_USAGE };
