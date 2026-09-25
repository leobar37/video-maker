/**
 * probe.ts — redacted credential probe for @videomaker/credentials.
 *
 * Resolves FAL_KEY, ZERNIO_API_KEY, ELEVENLABS_API_KEY and the R2Env members
 * (access key id, secret, endpoint, bucket, publicUrl + derived accountId),
 * then prints one line per item: name, present/missing, value length. The
 * values themselves are NEVER printed. Exit 0 when everything resolves; on
 * failure an actionable error (which env var or config file to set) goes to
 * stderr and the process exits non-zero. `--json` prints the same redacted
 * report as machine-readable JSON on stdout.
 */
import {
  CREDENTIAL_NAMES,
  CredentialMissingError,
  credentialReport,
  DOPPLER_CONFIG,
  DOPPLER_PROJECT,
  DOPPLER_TOKEN_ENV,
  resolveCredentials,
  resolveR2Env,
} from '../src/index';

const asJson = process.argv.includes('--json');

const GLOBAL_CONFIG_DISPLAY = '~/.config/elena-tech/config.json';

const errors: string[] = [];
const missingKeys: string[] = [];
for (const key of CREDENTIAL_NAMES) {
  try {
    await resolveCredentials(key, { mode: 'run' });
  } catch (error) {
    if (error instanceof CredentialMissingError) missingKeys.push(key);
    else errors.push(error instanceof Error ? error.message : String(error));
  }
}
if (missingKeys.length > 0) {
  errors.unshift(
    `${missingKeys.join(', ')} could not be resolved. Set them in the environment or the ` +
      `project .env, or provide a Doppler token via ${DOPPLER_TOKEN_ENV} or the ` +
      `"dopplerToken" field of ${GLOBAL_CONFIG_DISPLAY} so they can be downloaded from ` +
      `Doppler (${DOPPLER_PROJECT}/${DOPPLER_CONFIG}).`,
  );
}
try {
  await resolveR2Env({ mode: 'run' });
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

const report = await credentialReport({ mode: 'run' });
const error = errors.length > 0 ? errors.join('\n') : undefined;

if (asJson) {
  console.log(JSON.stringify({ ok: error === undefined, credentials: report, error }, null, 2));
} else {
  for (const entry of report) {
    console.log(`${entry.name}: ${entry.present ? 'present' : 'missing'} (length ${entry.length})`);
  }
  if (error) console.error(`error: ${error}`);
}

process.exit(error === undefined ? 0 : 1);
