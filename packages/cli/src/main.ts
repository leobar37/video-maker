#!/usr/bin/env bun
/**
 * Thin entry point of the production CLI: `bun packages/cli/src/main.ts <verb> ...`
 * (or `bun run vm <verb> ...` from the workspace root). All behavior is
 * interpreted from the declarative registry — see `src/all-specs.ts`.
 */
import { setArchiveStorageSource } from './persist';
import { createR2ArchiveStorageSource } from './persist/r2-wiring';
import { runCli } from './runtime';

const argv = process.argv.slice(2);
// Plan/dry runs must stay offline and secret-free (NFR-002): the R2 source is
// installed only for real runs — and even then it resolves lazily, only when an
// `archive` run actually asks for the store. Planning never reaches the seam.
const planMode = argv.some((token) => token === '--plan' || token === '--dry-run');
if (!planMode) {
  setArchiveStorageSource(createR2ArchiveStorageSource());
}

const exitCode = (await runCli(argv, { cwd: process.cwd() })) ?? 0;
// Remotion's bundler keeps a dev-server handle open for the whole process, so
// the CLI lingered long after the command had finished (observed 20+ min of
// dead wall time per clip render, which dominated batch runtimes). Flush
// stdout, then terminate deterministically.
await new Promise<void>((resolve) => {
  process.stdout.write('', () => resolve());
});
process.exit(exitCode);
