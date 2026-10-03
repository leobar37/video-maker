import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256File, sha256Json } from '@videomaker/core';
import {
  ClipDecisionSchema, ClipPilotEvidenceSchema, ClipPilotPolicySchema, FrameAnalysisSchema,
  type ClipDecision, type ClipPilotProvenance, type ClipRange, type FrameAnalysis,
} from '@videomaker/schemas';

import type { ClipWord } from '../pipeline/clip';
import { checkPilotClipQa } from './pilot-qa';

export interface ClipPilotReadyInput {
  projectDir: string;
  decisions: ClipDecision;
  selectedRanges: readonly ClipRange[];
  words: readonly ClipWord[];
  frames: readonly FrameAnalysis[];
}

function refuse(reason: string): never {
  // Never propagate JSON/parser/fs messages containing untrusted document data.
  throw new Error(`Editorial clip pilot: ${reason}. Review clips/pilot-policy.json and clips/pilot-evidence.json; sample approval is not publication approval.`);
}

/** Resolve only fixed or schema-validated relative paths, without following symlinks. */
async function localPath(projectDir: string, relative: string, optional = false): Promise<string | undefined> {
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    refuse('unsafe project-relative evidence path');
  }
  let path: string;
  try {
    path = await realpath(projectDir);
  } catch {
    refuse('project directory is unavailable');
  }
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) refuse('symlink evidence paths are forbidden');
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
        refuse('evidence path has an invalid file type');
      }
    } catch (error) {
      if (optional && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      if (error instanceof Error && error.message.startsWith('Editorial clip pilot:')) throw error;
      refuse('required project-local evidence is missing or unreadable');
    }
  }
  return path;
}

async function readLocalJson(projectDir: string, relative: string, optional = false): Promise<unknown> {
  const path = await localPath(projectDir, relative, optional);
  if (path === undefined) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    refuse('project-local evidence contains invalid JSON');
  }
}

async function hashLocal(projectDir: string, relative: string): Promise<string> {
  const path = await localPath(projectDir, relative);
  try {
    return await sha256File(path!);
  } catch {
    refuse('required project-local artifact cannot be hashed');
  }
}

/** Read-only provenance for writing/reviewing evidence; never creates approval. */
export async function readClipPilotProvenance(input: Omit<ClipPilotReadyInput, 'selectedRanges'>): Promise<ClipPilotProvenance> {
  const { projectDir, decisions, words, frames } = input;
  const parsedDecision = ClipDecisionSchema.safeParse(await readLocalJson(projectDir, 'clips/decisions.json'));
  if (!parsedDecision.success || sha256Json(parsedDecision.data) !== sha256Json(decisions)) {
    refuse('sealed decisions changed or are invalid');
  }
  const sourceSha256 = await hashLocal(projectDir, 'clips/source.mp4');
  const source = await readLocalJson(projectDir, 'clips/source.json');
  if (sourceSha256 !== decisions.sourceSha256 || typeof source !== 'object' || source === null
    || !('sha256' in source) || source.sha256 !== sourceSha256) {
    refuse('source does not match the sealed decision and source manifest');
  }
  const transcript = await readLocalJson(projectDir, 'clips/transcript.json');
  if (typeof transcript !== 'object' || transcript === null || !('words' in transcript)
    || !Array.isArray(transcript.words) || sha256Json(transcript.words) !== sha256Json(words)) {
    refuse('transcript does not match the loaded render context');
  }
  // Reject symlinked parent directories before listing or opening any shard.
  const root = await realpath(projectDir);
  for (const relative of ['clips', 'clips/analysis']) {
    try {
      const stat = await lstat(join(root, relative));
      if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('unsafe analysis directory');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Editorial clip pilot:')) throw error;
      refuse('analysis directory is missing or unreadable');
    }
  }
  let names: string[];
  try {
    names = (await readdir(join(root, 'clips/analysis'))).filter((name) => name.endsWith('.json')).sort();
  } catch {
    refuse('analysis directory is unreadable');
  }
  const currentFrames: FrameAnalysis[] = [];
  const shards: { name: string; sha256: string }[] = [];
  for (const name of names) {
    const relative = `clips/analysis/${name}`;
    const document = await readLocalJson(projectDir, relative);
    if (typeof document !== 'object' || document === null || !('frames' in document) || !Array.isArray(document.frames)) {
      refuse('analysis shard has no frame evidence');
    }
    if ('sourceSha256' in document && document.sourceSha256 !== sourceSha256) {
      refuse('analysis shard belongs to a different source');
    }
    for (const frame of document.frames) {
      const parsed = FrameAnalysisSchema.safeParse(frame);
      if (!parsed.success) refuse('analysis shard contains invalid frame evidence');
      currentFrames.push(parsed.data);
    }
    shards.push({ name, sha256: await hashLocal(projectDir, relative) });
  }
  if (currentFrames.length === 0 || sha256Json(currentFrames) !== sha256Json(frames)) {
    refuse('frame analysis does not match the loaded render context');
  }
  const frameIds = new Set(currentFrames.map((frame) => frame.frame_id));
  if (frameIds.size !== currentFrames.length) refuse('frame analysis contains ambiguous duplicate frame ids');
  return {
    sourceSha256,
    sourceManifestSha256: await hashLocal(projectDir, 'clips/source.json'),
    transcriptSha256: await hashLocal(projectDir, 'clips/transcript.json'),
    decisionsSha256: sha256Json(parsedDecision.data),
    framesSha256: sha256Json(currentFrames),
    analysisSha256: sha256Json(shards),
  };
}

/** Optional editorial pilot gate, checked before any trim, stage, render or output. */
export async function assertClipPilotReady(input: ClipPilotReadyInput): Promise<void> {
  const rawPolicy = await readLocalJson(input.projectDir, 'clips/pilot-policy.json', true);
  if (rawPolicy === undefined) return;
  const policyResult = ClipPilotPolicySchema.safeParse(rawPolicy);
  if (!policyResult.success) refuse('configured policy is invalid');
  const policy = policyResult.data;
  if (!policy.enabled) return;

  const approved = input.decisions.decisions.filter((entry) => entry.status === 'approved');
  const approvedById = new Map(approved.map((entry) => [entry.range.id, entry.range]));
  if (policy.sampleIds.some((id) => !approvedById.has(id))) refuse('configured sample ids must be sealed approved ranges');
  for (const range of input.selectedRanges) {
    const sealed = approvedById.get(range.id);
    if (sealed === undefined || sha256Json(sealed) !== sha256Json(range)) refuse('selected range is not sealed and approved');
  }
  const samples = new Set(policy.sampleIds);
  // Even the initial sample creation must not overwrite a symlink target.
  for (const range of input.selectedRanges) {
    if (samples.has(range.id)) await localPath(input.projectDir, `renders/clips/${range.id}.mp4`, true);
  }
  // A named --id is not a bypass: only policy-designated samples can be created
  // before evidence exists, and a mixed selection must satisfy the whole gate.
  if (input.selectedRanges.length > 0 && input.selectedRanges.every((range) => samples.has(range.id))) return;

  const evidenceResult = ClipPilotEvidenceSchema.safeParse(await readLocalJson(input.projectDir, 'clips/pilot-evidence.json'));
  if (!evidenceResult.success) refuse('pilot evidence is invalid');
  const evidence = evidenceResult.data;
  if (evidence.approval !== 'approved') refuse('montage sample has not been editorially approved');
  if (evidence.contentType !== policy.contentType) refuse('reviewed content type does not match the policy');
  if (!samples.has(evidence.sample.rangeId)) refuse('reviewed sample is not a policy-designated sample');
  const provenance = await readClipPilotProvenance(input);
  if (sha256Json(provenance) !== sha256Json(evidence.provenance)) refuse('pilot provenance is stale');
  if (await hashLocal(input.projectDir, evidence.sample.path) !== evidence.sample.sha256) {
    refuse('approved sample artifact has changed');
  }
  if (!evidence.transcriptReview.trustworthy || !evidence.framingReview.safeFramingReviewed || !evidence.framingReview.layoutReviewed) {
    refuse('trustworthy transcript and human framing/layout reviews are required');
  }
  if (evidence.transcriptReview.unreliableWordIndexes.some((index) => index >= input.words.length)) {
    refuse('unresolved transcript indexes are invalid');
  }
  for (const example of evidence.examples) {
    const sealed = input.decisions.decisions.find((entry) => entry.range.id === example.range.id);
    if (sealed === undefined || sha256Json(sealed.range) !== sha256Json(example.range)
      || sealed.status !== (example.kind === 'positive' ? 'approved' : 'rejected')) {
      refuse('reviewed editorial examples do not match sealed positive and negative decisions');
    }
  }
  if (!evidence.examples.some((example) => example.kind === 'positive' && example.range.id === evidence.sample.rangeId)) {
    refuse('the approved sample needs a positive four-criterion editorial review');
  }
  const framesById = new Map(input.frames.map((frame) => [frame.frame_id, frame]));
  for (const { range } of approved) {
    const edl = evidence.edl.find((entry) => entry.range.id === range.id);
    if (edl === undefined || sha256Json(edl.range) !== sha256Json(range)) refuse('approved ranges need current cut/layout EDL evidence');
    for (const [boundary, t] of [[edl.startFrame, range.start], [edl.endFrame, range.end]] as const) {
      const current = framesById.get(boundary.frame_id);
      if (current === undefined || boundary.t !== t || sha256Json(current) !== sha256Json(boundary)) {
        refuse('EDL boundary frames do not match current exact cuts');
      }
    }
    const qa = checkPilotClipQa({
      range, words: input.words, frames: input.frames,
      reactionWindows: edl.reactionWindows, layoutChanges: edl.layoutChanges,
      transcriptReviewed: evidence.transcriptReview.trustworthy,
      unreliableWordIndexes: evidence.transcriptReview.unreliableWordIndexes,
      safeFramingReviewed: evidence.framingReview.safeFramingReviewed && evidence.framingReview.layoutReviewed,
    });
    if (!qa.ok) refuse('cut, reaction, subtitle or safe-framing QA failed');
  }
}
