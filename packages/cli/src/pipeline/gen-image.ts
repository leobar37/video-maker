/**
 * FAL image generation for vertical backgrounds (port of the elena
 * `gen-image --asset-root` idea onto the video-maker paid-operation rules):
 * explicit `--spend-cap` gate, per-attempt estimate check, queue receipt,
 * bounded poll, download + dimension probe, idempotent journal.
 *
 * No auto-retry without reconcile: a journal without receipt is `uncertain`
 * and blocks resubmits until inspected.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

import { getKeyframeModel, keyframeAttemptCostMicros } from '@videomaker/providers';

import type { FetchImpl } from './ig';
import { parsePngDimensions } from './cover';

export const GEN_IMAGE_MODEL = 'fal-ai/flux/schnell';
export const FAL_QUEUE_BASE = 'https://queue.fal.run';
export const MAX_POLL_ATTEMPTS = 40;
export const POLL_INTERVAL_MS = 5000;

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  '9:16': { width: 768, height: 1344 },
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 960, height: 1200 },
  '16:9': { width: 1344, height: 768 },
};

/** Canonical pixel size for an aspect label. Pure. */
export function aspectSize(aspect: string): { width: number; height: number } {
  const size = ASPECT_SIZES[aspect];
  if (!size) {
    throw new Error(`gen-image: aspect-ratio desconocido "${aspect}" (válidos: ${Object.keys(ASPECT_SIZES).join(', ')}).`);
  }
  return size;
}

/** USD estimate for one attempt of the image model. Pure. */
export function estimateAttemptUsd(aspect: string, modelId: string = GEN_IMAGE_MODEL): number {
  const model = getKeyframeModel(modelId);
  return keyframeAttemptCostMicros(model, aspectSize(aspect)) / 1_000_000;
}

export interface GenImageJournal {
  schemaVersion: 1;
  prompt: string;
  model: string;
  aspect: string;
  width: number;
  height: number;
  estimatedUsd: number;
  status: 'completed' | 'uncertain' | 'failed';
  requestId?: string;
  output?: string;
  outputWidth?: number;
  outputHeight?: number;
  updatedAt: string;
  error?: string;
}

export interface GenImageDeps {
  fetchImpl: FetchImpl;
  falKey: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

/** FAL error detail (truncated; never contains our key — it travels in headers). */
async function falErrorDetail(response: { status: number; text: () => Promise<string> }): Promise<string> {
  try {
    const body = (await response.text()).trim().slice(0, 300);
    return body.length > 0 ? ` HTTP ${response.status}: ${body}` : ` HTTP ${response.status}`;
  } catch {
    return ` HTTP ${response.status}`;
  }
}

async function postJson(fetchImpl: FetchImpl, apiKey: string, url: string, body: unknown): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`gen-image: FAL${await falErrorDetail(response)} en ${url}.`);
  }
  return response.json();
}

async function getJson(fetchImpl: FetchImpl, apiKey: string, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { Authorization: `Key ${apiKey}` } });
  if (!response.ok) {
    throw new Error(`gen-image: FAL${await falErrorDetail(response)} en ${url}.`);
  }
  return response.json();
}

/**
 * Submits one image, polls the queue, downloads to `outPath` and journals
 * the attempt. Replays a completed journal instead of spending twice.
 */
export async function runGenImage(
  options: {
    projectDir: string;
    prompt: string;
    outPath: string;
    aspect: string;
    spendCapUsd: number;
    force: boolean;
    out: (line: string) => void;
  },
  deps: GenImageDeps,
): Promise<{ outPath: string; width: number; height: number; spentUsd: number }> {
  const { width, height } = aspectSize(options.aspect);
  const estimatedUsd = estimateAttemptUsd(options.aspect);
  if (estimatedUsd > options.spendCapUsd) {
    throw new Error(
      `gen-image: estimado $${estimatedUsd.toFixed(4)} supera el cap $${options.spendCapUsd} (subí --spend-cap).`,
    );
  }
  const journalPath = join(options.projectDir, 'qa', 'gen-image.json');
  const existing = await readJournal(journalPath);
  if (
    existing &&
    !options.force &&
    existing.status === 'completed' &&
    existing.prompt === options.prompt &&
    existing.output === options.outPath
  ) {
    options.out(`gen-image: replay ${options.outPath} (sin gastar dos veces).`);
    return {
      outPath: options.outPath,
      width: existing.outputWidth ?? width,
      height: existing.outputHeight ?? height,
      spentUsd: 0,
    };
  }
  if (existing && existing.status === 'uncertain' && !options.force) {
    throw new Error(
      `gen-image: intento previo "uncertain" sin receipt en ${journalPath}; inspeccionalo o pasá --force.`,
    );
  }
  const apiKey = await deps.falKey();
  const receipt = (await postJson(deps.fetchImpl, apiKey, `${FAL_QUEUE_BASE}/${GEN_IMAGE_MODEL}`, {
    prompt: options.prompt,
    image_size: { width, height },
    num_images: 1,
  })) as { request_id?: string; status_url?: string; response_url?: string };
  if (!receipt.request_id || !receipt.status_url || !receipt.response_url) {
    await writeJournal(journalPath, baseJournal(options, estimatedUsd, 'uncertain', 'sin receipt de FAL'));
    throw new Error('gen-image: FAL no devolvió request_id/status_url/response_url (uncertain, sin reintento).');
  }
  options.out(`gen-image: submit ${receipt.request_id} (~$${estimatedUsd.toFixed(4)}).`);
  let status = '';
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const payload = (await getJson(deps.fetchImpl, apiKey, receipt.status_url)) as { status?: string };
    status = String(payload.status ?? '').toUpperCase();
    if (status === 'COMPLETED') break;
    if (status === 'FAILED' || status === 'CANCELLED') {
      await writeJournal(journalPath, {
        ...baseJournal(options, estimatedUsd, 'failed', `FAL status ${status}`),
        requestId: receipt.request_id,
      });
      throw new Error(`gen-image: FAL devolvió ${status}.`);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  if (status !== 'COMPLETED') {
    await writeJournal(journalPath, {
      ...baseJournal(options, estimatedUsd, 'uncertain', 'poll agotado sin COMPLETED'),
      requestId: receipt.request_id,
    });
    throw new Error('gen-image: poll agotado (uncertain, sin reintento automático).');
  }
  const result = (await getJson(deps.fetchImpl, apiKey, receipt.response_url)) as {
    images?: Array<{ url?: string }>;
  };
  const imageUrl = result.images?.[0]?.url;
  if (!imageUrl) {
    await writeJournal(journalPath, {
      ...baseJournal(options, estimatedUsd, 'uncertain', 'respuesta sin images[0].url'),
      requestId: receipt.request_id,
    });
    throw new Error('gen-image: respuesta FAL sin images[0].url (uncertain).');
  }
  const download = await deps.fetchImpl(imageUrl);
  if (!download.ok) throw new Error(`gen-image: descarga HTTP ${download.status}.`);
  const raw = new Uint8Array(await download.arrayBuffer());
  // FAL puede devolver JPEG/WEBP: normalizar a PNG antes de guardar y medir.
  const png = await sharp(raw).png().toBuffer();
  await mkdir(join(options.projectDir, 'covers'), { recursive: true });
  await writeFile(options.outPath, png);
  const dims = parsePngDimensions(new Uint8Array(png));
  await writeJournal(journalPath, {
    ...baseJournal(options, estimatedUsd, 'completed'),
    requestId: receipt.request_id,
    output: options.outPath,
    outputWidth: dims.width,
    outputHeight: dims.height,
  });
  options.out(`gen-image: ${options.outPath} ${dims.width}x${dims.height}.`);
  return { outPath: options.outPath, width: dims.width, height: dims.height, spentUsd: estimatedUsd };
}

function baseJournal(
  options: { prompt: string; aspect: string; outPath: string },
  estimatedUsd: number,
  status: GenImageJournal['status'],
  error?: string,
): GenImageJournal {
  const { width, height } = aspectSize(options.aspect);
  return {
    schemaVersion: 1,
    prompt: options.prompt,
    model: GEN_IMAGE_MODEL,
    aspect: options.aspect,
    width,
    height,
    estimatedUsd,
    status,
    updatedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

async function readJournal(path: string): Promise<GenImageJournal | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as GenImageJournal;
    return parsed?.schemaVersion === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeJournal(path: string, journal: GenImageJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(journal, null, 2));
}
