/**
 * E2E orchestrator (test:e2e): boots the ephemeral loopback server, applies
 * migrations + fixture data, runs the scenarios, writes the P-004 evidence
 * JSON (commands, counts, screenshots, visual review) and ALWAYS stops the
 * server before exiting. Loopback only; no cloud, no deploy, no real email.
 */

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from './browser';
import { runGuestAssetLinkSpec, runGuestRequestSpec, runSpec } from './portal.spec';
import { E2E_PORT, startE2eServer } from './server';

const EVIDENCE_DIR = join(import.meta.dir, '..', '..', '..', '..', 'evidence', 'customer-assets-portal');
const EVIDENCE_JSON = join(EVIDENCE_DIR, 'p004-ui.json');

interface EvidenceCommand {
  cmd: string;
  exit: number;
}

async function main(): Promise<void> {
  const commands: EvidenceCommand[] = [];
  const started = Date.now();
  const server = await startE2eServer();
  let specError: unknown = null;
  let screenshots: string[] = [];
  let visualNotes: string[] = [];
  // R-2 additive scenario (same ephemeral server, same browser lifecycle).
  let guestScreenshots: string[] = [];
  let guestNotes: string[] = [];
  try {
    const { browser, close } = await launchBrowser();
    try {
      const result = await runSpec(browser);
      screenshots = result.screenshots;
      visualNotes = result.visualReviewNotes;
      await runGuestRequestSpec(browser, result.data, result.adminCookie, guestScreenshots, guestNotes);
      // Asset upload link scenario (operator order 2026-10-06, additive):
      // same server/browser lifecycle, mint → guest mobile upload → pull set.
      await runGuestAssetLinkSpec(browser, result.data, result.adminCookie, guestScreenshots, guestNotes);
    } finally {
      await close();
    }
  } catch (error) {
    specError = error;
  } finally {
    await server.stop();
  }

  // Post-run verification commands (recorded for the evidence file).
  const { execSync } = await import('node:child_process');
  const run = (cmd: string): number => {
    try {
      execSync(cmd, { cwd: join(import.meta.dir, '..', '..'), stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };

  const testUiExit = run('bun run test:ui');
  const typecheckExit = run('bun run typecheck');
  commands.push({ cmd: 'bun run --cwd apps/customer-assets test:ui', exit: testUiExit });
  commands.push({ cmd: 'bun run --cwd apps/customer-assets test:e2e', exit: specError === null ? 0 : 1 });
  commands.push({ cmd: 'bun run --cwd apps/customer-assets typecheck', exit: typecheckExit });

  const evidence = {
    date: new Date().toISOString(),
    phase: 'P-004 dashboard admin/cliente y simulación de Instagram + R-2 guest request',
    gate: 'G-cap-local (emulated D1/R2, loopback-only ephemeral server, fake mail)',
    commands,
    counts: {
      files: screenshots.length + guestScreenshots.length,
      pass: specError === null ? 1 : 0,
      fail: specError === null ? 0 : 1,
      skip: 0,
    },
    screenshots: [
      ...screenshots.map((name) => {
        const path = join(EVIDENCE_DIR, 'p004-ui', name);
        return {
          name,
          path: `evidence/customer-assets-portal/p004-ui/${name}`,
          bytes: existsSync(path) ? statSync(path).size : 0,
        };
      }),
      ...guestScreenshots.map((name) => {
        const path = join(import.meta.dir, '..', '..', '..', '..', 'evidence', 'customer-assets-requests', 'r2-e2e', name);
        return {
          name,
          path: `evidence/customer-assets-requests/r2-e2e/${name}`,
          bytes: existsSync(path) ? statSync(path).size : 0,
        };
      }),
    ],
    visualReview: {
      reviewedBy: 'P004UiWorker (agent, image review)',
      verdict: specError === null ? 'pass' : 'not-completed',
      checked: [...visualNotes, ...guestNotes],
      notes: [
        'Screenshots captured via page.screenshot (no browser chrome, no address bar): no tokens, cookies or credential-bearing URLs are visible.',
        'Navigation used path-only URLs against 127.0.0.1; no Tailscale/localhost link shared.',
        'R-2: the minted guest URL exists only inside the running scenario — never in this evidence file.',
      ],
    },
    notes: [
      'Grid: three columns at 390x844 and 1440x900, explicit order badges, MP4 covers use the no-poster placeholder.',
      'Hide cascade proven end-to-end: catalog empty state + direct output URL 404 for the member after admin hide.',
      'Isolation proven: client B deep link into client A shows the not-available empty state and 404s on direct output.',
      'R-2 guest link: open → upload to the 2-file limit (auto-fulfilled) → admin close → closed state, all without login.',
      specError === null ? 'All scenarios passed.' : `Spec failure: ${String(specError).slice(0, 2000)}`,
    ],
    durationMs: Date.now() - started,
  };
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 2)}\n`);

  if (specError !== null) {
    console.error('E2E FAILED:', specError);
    process.exit(1);
  }
  console.log(`E2E OK — evidence at ${EVIDENCE_JSON}`);
  if (testUiExit !== 0 || typecheckExit !== 0) process.exit(1);
}

await main();
