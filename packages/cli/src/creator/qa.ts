import { readFile } from 'node:fs/promises';
import { CreatorProbeSchema as ProbeSchema } from '@videomaker/schemas';
import { buildEbur128MeasureArgs, parseEbur128Summary } from '@videomaker/motion-remotion/loudness';
import type { MediaCommandDeps } from '../pipeline/deps';
import { FileSpendLedger, openAttempts, spendLedgerPath } from '../pipeline/spend-ledger';
import { approvalDigest, loadProject, localPath, QaSchema, readJson, sha256, writeJson, type Draft, type Preset, type MediaQa } from './model';

export function mediaPolicyProblems(qa: MediaQa, preset: Preset): string[] {
  const { editing, publishing } = preset;
  const problems: string[] = [];
  if (qa.width !== editing.width || qa.height !== editing.height || Math.abs(qa.fps - editing.fps) > 0.001) problems.push(`Require ${editing.width}x${editing.height}@${editing.fps}`);
  if (qa.videoCodec !== editing.render.videoCodec || qa.audioCodec !== editing.render.audioCodec || qa.audioTracks !== editing.audio.tracks) problems.push('Video/audio codec or track count differs from preset');
  if (editing.render.pixelFormat !== undefined && qa.pixelFormat !== editing.render.pixelFormat) problems.push(`Require pixel format ${editing.render.pixelFormat}`);
  if (editing.render.sampleRate !== undefined && qa.sampleRate !== editing.render.sampleRate) problems.push(`Require audio sample rate ${editing.render.sampleRate}`);
  if (Math.abs(qa.integratedLufs - editing.audio.targetLufs) > (editing.audio.lufsTolerance ?? 1) || qa.truePeakDbtp > editing.audio.maxTruePeakDbtp) problems.push(`Loudness requires ${editing.audio.targetLufs}±${editing.audio.lufsTolerance ?? 1} LUFS and <=${editing.audio.maxTruePeakDbtp} dBTP`);
  if (qa.coverWidth !== editing.width || qa.coverHeight !== editing.height) problems.push('PNG cover dimensions differ from preset');
  for (const target of publishing.targets) if (target.constraints?.maxDurationSeconds !== undefined && qa.duration > target.constraints.maxDurationSeconds) problems.push(`${target.platform}: video exceeds ${target.constraints.maxDurationSeconds}s target cap`);
  return problems;
}
export async function measureMedia(project: string, draft: Draft, preset: Preset, deps: MediaCommandDeps) {
  const video = await localPath(project, draft.video);
  const cover = await localPath(project, draft.cover);
  const videoSha256 = sha256(await readFile(video));
  const coverSha256 = sha256(await readFile(cover));
  const probe = async (path: string) => {
    const result = await deps.process.run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
    if (result.code !== 0) throw new Error('ffprobe failed; repair media before publication');
    return ProbeSchema.parse(JSON.parse(result.stdout));
  };
  const facts = await probe(video);
  const image = await probe(cover);
  const videoStreams = facts.streams.filter((s) => s.codec_type === 'video');
  const audioStreams = facts.streams.filter((s) => s.codec_type === 'audio');
  if (videoStreams.length !== 1 || audioStreams.length !== preset.editing.audio.tracks || image.streams.length !== 1) throw new Error('Require one video, preset audio track count and one PNG image');
  if (audioStreams.some((stream) => stream.codec_name !== preset.editing.render.audioCodec)) throw new Error('Audio codec differs from preset');
  const stream = videoStreams[0]!;
  const [numerator, denominator] = (stream.avg_frame_rate ?? '').split('/').map(Number);
  for (const path of [video, cover]) {
    const decode = await deps.process.run('ffmpeg', ['-v', 'error', '-nostdin', '-xerror', '-i', path, '-map', '0', '-f', 'null', '-']);
    if (decode.code !== 0 || decode.stderr.trim()) throw new Error('Full media decode failed; inspect source/render');
  }
  const loudness = await deps.ffmpeg.run(buildEbur128MeasureArgs(video));
  if (loudness.exitCode !== 0) throw new Error('Loudness measurement failed');
  const stats = parseEbur128Summary(loudness.stderr);
  const qa = QaSchema.parse({
    schemaVersion: 1, videoSha256, coverSha256, width: stream.width, height: stream.height,
    fps: numerator! / denominator!, videoCodec: stream.codec_name, audioCodec: audioStreams[0]!.codec_name, audioTracks: audioStreams.length,
    ...(stream.pix_fmt !== undefined ? { pixelFormat: stream.pix_fmt } : {}),
    ...(audioStreams[0]!.sample_rate !== undefined ? { sampleRate: Number(audioStreams[0]!.sample_rate) } : {}),
    duration: Number(facts.format.duration), integratedLufs: stats.integratedLufs, truePeakDbtp: stats.truePeakDbtp, decoded: true, coverDecoded: true,
    coverWidth: image.streams[0]!.width, coverHeight: image.streams[0]!.height, coverCodec: image.streams[0]!.codec_name,
  });
  const problems = mediaPolicyProblems(qa, preset);
  if (problems.length) throw new Error(problems.join('; '));
  if (sha256(await readFile(video)) !== videoSha256 || sha256(await readFile(cover)) !== coverSha256) throw new Error('Media changed during QA');
  return qa;
}
export async function runCreatorQa(project: string, deps: MediaCommandDeps) {
  const { draft, preset } = await loadProject(project);
  const qa = await measureMedia(project, draft, preset, deps);
  await writeJson(project, 'qa/creator-media.json', qa);
  return qa;
}

/** Offline planning reads local hashes/evidence only; no processes, network, secrets or writes. */
export async function planPublication(project: string, spendCap: unknown) {
  const blockers: string[] = [];
  const loaded = await loadProject(project);
  const { manifest, preset, draft } = loaded;
  if (typeof spendCap !== 'number' || !Number.isFinite(spendCap) || spendCap < 0) blockers.push('Supply explicit --spend-cap 0 (no paid generation is performed)');
  if (!draft.title.trim()) blockers.push('Fill publication/draft.json title with original text');
  const platforms = preset.publishing.targets.map((target) => target.platform);
  for (const platform of Object.keys(draft.platformContent)) if (!platforms.some((item) => item === platform)) blockers.push(`Remove unused platformContent.${platform}; it is not a selected target`);
  for (const target of preset.publishing.targets) {
    const text = draft.platformContent[target.platform] || draft.content;
    if (!text.trim()) blockers.push(`Fill original content or platformContent.${target.platform}`);
    const maxText = target.constraints?.maxTextCharacters;
    const maxTitle = target.constraints?.maxTitleCharacters;
    if (maxText !== undefined && Array.from(text).length > maxText) blockers.push(`${target.platform}: text exceeds ${maxText} characters`);
    if (maxTitle !== undefined && Array.from(draft.title).length > maxTitle) blockers.push(`${target.platform}: title exceeds ${maxTitle} characters`);
    if ((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > preset.publishing.maxHashtags) blockers.push(`${target.platform}: use no more than ${preset.publishing.maxHashtags} hashtags`);
  }
  if (draft.syntheticMedia === null) blockers.push('Set syntheticMedia explicitly to true or false');
  let digest: string | undefined;
  let media: { videoSha256: string; coverSha256: string } | undefined;
  try {
    media = { videoSha256: sha256(await readFile(await localPath(project, draft.video))), coverSha256: sha256(await readFile(await localPath(project, draft.cover))) };
    digest = approvalDigest(manifest, preset, draft, media.videoSha256, media.coverSha256);
  } catch (error) { blockers.push(`Select safe existing video and cover paths: ${error instanceof Error ? error.message : 'invalid media'}`); }
  try {
    const qa = QaSchema.parse(await readJson(project, 'qa/creator-media.json'));
    blockers.push(...mediaPolicyProblems(qa, preset));
    if (!media || qa.videoSha256 !== media.videoSha256 || qa.coverSha256 !== media.coverSha256) blockers.push('QA hash mismatch: run creator-qa on current media');
  } catch { blockers.push('Missing/invalid QA: run creator-qa; media must match snapshot format, loudness, PNG cover and each selected target duration cap'); }
  if (!digest || !draft.approval.approved || draft.approval.digest !== digest) blockers.push('Review current render, cover, text and all selected targets, then set approval.approved=true and approval.digest to the candidate digest');
  try {
    await localPath(project, 'qa/spend.json', true);
    const unresolved = await openAttempts(new FileSpendLedger(spendLedgerPath(project)));
    if (unresolved.length) blockers.push('Resolve submitted/uncertain paid attempts in qa/spend.json; publication spend gate is closed');
  } catch { blockers.push('Invalid or unsafe qa/spend.json; repair/reconcile ledger before publishing'); }
  return { ...loaded, blockers, digest, media, remoteValidation: 'NOT CHECKED: run revalidates exact profile/accounts/health, selected platform capability and R2 integrity' };
}
