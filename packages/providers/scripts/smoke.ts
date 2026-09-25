#!/usr/bin/env bun
/**
 * `providers:smoke --plan` — offline configuration smoke for the provider
 * adapters.
 *
 * By construction the plan mode:
 * - never touches the network (no fetch is ever created or called);
 * - never reads secret values: only NAME presence/absence is inspected and
 *   reported (NFR-001); with zero environment it prints what WOULD be
 *   required and exits 0;
 * - validates the R2 bucket/public-URL pair coherence expectations (the pair
 *   is one declaration: both or neither) and the Zernio required names;
 * - prints a redacted plan of what each adapter would do in run mode.
 *
 * Exit codes: 0 = coherent plan, 1 = incoherent declarations (actionable
 * errors), 2 = usage.
 */
import { processEnvPresence, type EnvPresence } from '../src/storage/context';
import { describeStoragePlan, type AdapterPlanReport } from '../src/storage/plan';
import { describeZernioPlan } from '../src/zernio/plan';

export interface SmokeOptions {
  /** Name-presence seam; defaults to `process.env` names only. */
  presence?: EnvPresence;
  /** Output seam (one line at a time). */
  write?: (line: string) => void;
}

export interface SmokeReport {
  ok: boolean;
  lines: string[];
  errors: string[];
}

function formatReport(report: AdapterPlanReport, out: string[]): void {
  out.push(`[${report.adapter}]`);
  const names = report.names.map(
    (name) => `${name}=${report.present.includes(name) ? 'declared' : 'missing'}`,
  );
  out.push(`  names (presence only): ${names.join(' ')}`);
  if (report.missing.length > 0) {
    out.push(`  would require: ${report.missing.join(', ')}`);
  }
  for (const error of report.errors) out.push(`  ERROR: ${error}`);
  for (const step of report.would) out.push(`  would: ${step}`);
}

/**
 * Pure plan run: reports name presence and pair coherence for every adapter.
 * Coherent = no errors; missing names are "would require", never errors, so a
 * zero-env plan is valid.
 */
export function runSmokePlan(opts: SmokeOptions = {}): SmokeReport {
  const presence = opts.presence ?? processEnvPresence;
  const reports = [describeStoragePlan(presence), describeZernioPlan(presence)];
  const lines: string[] = [
    'providers smoke — plan (offline; name presence only; no secret values read)',
  ];
  const errors: string[] = [];
  for (const report of reports) {
    formatReport(report, lines);
    for (const error of report.errors) errors.push(`[${report.adapter}] ${error}`);
  }
  return { ok: errors.length === 0, lines, errors };
}

const USAGE = 'usage: bun packages/providers/scripts/smoke.ts --plan';

/** CLI entry. Returns the process exit code. */
export async function main(argv: string[], opts: SmokeOptions = {}): Promise<number> {
  const write = opts.write ?? ((line: string) => console.log(line));
  if (argv.length !== 1 || argv[0] !== '--plan') {
    write(USAGE);
    write('only --plan is supported: the smoke runs offline and secret-free by construction.');
    return 2;
  }
  const report = runSmokePlan(opts);
  for (const line of report.lines) write(line);
  if (report.ok) {
    write('OK: configuration coherent (missing names above are only "would require" in plan mode).');
    return 0;
  }
  write(`FAILED: ${report.errors.length} incoherent declaration(s); fix the errors above.`);
  return 1;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
