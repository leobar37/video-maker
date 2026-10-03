import {
  ClipLayoutSchema,
  ClipRangeSchema,
  FrameAnalysisSchema,
  type ClipLayout,
  type ClipRange,
  type FrameAnalysis,
} from '@videomaker/schemas';
import type { ClipWord } from '../pipeline/clip';

export interface PilotClipQaInput {
  range: ClipRange;
  words: readonly ClipWord[];
  frames: readonly FrameAnalysis[];
  reactionWindows?: readonly { start: number; end: number }[];
  layoutChanges?: readonly { t: number; layout: ClipLayout; frameId: string }[];
  transcriptReviewed: boolean;
  unreliableWordIndexes?: readonly number[];
  safeFramingReviewed: boolean;
}

/** Conservative evidence check, not a quality score or publication approval.
 * All clocks are source clocks. Review booleans attest manual review; this
 * function cannot establish that a human listened to real audio.
 */
export function checkPilotClipQa(input: PilotClipQaInput): {
  ok: boolean;
  problems: readonly string[];
} {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  const parsed = ClipRangeSchema.safeParse(input.range);
  if (!parsed.success) return { ok: false, problems: ['Invalid ClipRange evidence.'] };
  const range = parsed.data;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    return { ok: false, problems: ['Clip bounds must be finite.'] };
  }
  if (!input.transcriptReviewed) fail('Transcript must be reviewed before burned subtitles.');
  if (!input.safeFramingReviewed) fail('Conservative safe framing must be reviewed.');
  const unreliable = new Set(input.unreliableWordIndexes ?? []);
  for (const index of unreliable) {
    if (!Number.isInteger(index) || index < 0 || index >= input.words.length) {
      fail('Invalid unreliable word index.');
    }
  }
  let retainedWords = 0;
  input.words.forEach((word, index) => {
    if (!word.word.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
        word.start < 0 || word.end <= word.start) {
      fail(`Invalid word evidence at index ${index}.`);
      return;
    }
    if (word.start < range.end && word.end > range.start) {
      retainedWords += 1;
      if (unreliable.has(index)) fail(`Disputed word ${index} cannot justify burned subtitles.`);
    }
    if ((word.start < range.start && range.start < word.end) ||
        (word.start < range.end && range.end < word.end)) {
      fail(`Cut bisects word ${index}.`);
    }
  });
  if (retainedWords === 0) fail('Missing word evidence for burned subtitles.');

  const frames: FrameAnalysis[] = [];
  const ids = new Set<string>();
  for (const raw of input.frames) {
    const frame = FrameAnalysisSchema.safeParse(raw);
    if (!frame.success || !Number.isFinite(raw.t)) {
      fail('Invalid FrameAnalysis evidence.');
      continue;
    }
    if (ids.has(frame.data.frame_id)) fail(`Duplicate frame ID ${frame.data.frame_id}.`);
    ids.add(frame.data.frame_id);
    frames.push(frame.data);
  }
  const relevant = frames.filter((frame) => frame.t >= range.start && frame.t <= range.end);
  for (const t of [range.start, range.end]) {
    if (!relevant.some((frame) => frame.t === t)) fail(`Missing exact boundary frame at ${t}.`);
  }
  const changes = [...(input.layoutChanges ?? [])];
  let previous = -Infinity;
  for (const change of changes) {
    if (!Number.isFinite(change.t) || change.t < range.start || change.t > range.end ||
        change.t <= previous || !ClipLayoutSchema.safeParse(change.layout).success ||
        !relevant.some((frame) => frame.frame_id === change.frameId && frame.t === change.t)) {
      fail(`Invalid exact EDL frame/time evidence at ${change.t}.`);
    }
    previous = change.t;
  }
  for (const frame of relevant) {
    if (frame.sceneCut && frame.t > range.start && frame.t < range.end &&
        !changes.some((change) => change.t === frame.t && change.frameId === frame.frame_id)) {
      fail(`Camera switch ${frame.frame_id} missing from EDL.`);
    }
    const layout = [...changes].reverse().find((change) => change.t <= frame.t)?.layout ?? range.layout;
    const onScreen = frame.speakers.filter((speaker) => {
      const [x, y, width, height] = speaker.bbox;
      return x + width <= 1000 && y + height <= 1000;
    });
    if (onScreen.length !== frame.speakers.length) fail(`Off-screen bbox at ${frame.frame_id}.`);
    if (layout === 'duo') {
      if (range.faces.length !== 2 || new Set(range.faces.map((face) => face.id)).size !== 2 ||
          !range.faces.every((face) => onScreen.some((speaker) => speaker.id === face.id))) {
        fail(`Duo face/framing evidence missing at ${frame.frame_id}.`);
      }
    } else if (!range.faces.some((face) => onScreen.some((speaker) => speaker.id === face.id))) {
      fail(`Single safe framing evidence missing at ${frame.frame_id}.`);
    }
  }
  for (const face of range.faces) {
    const [x, y, width, height] = face.bbox;
    if (x + width > 1000 || y + height > 1000 || face.presence <= 0) {
      fail(`Invalid on-screen representative face ${face.id}.`);
    }
  }
  for (const reaction of input.reactionWindows ?? []) {
    if (!Number.isFinite(reaction.start) || !Number.isFinite(reaction.end) ||
        reaction.end <= reaction.start || reaction.start < range.start || reaction.end > range.end) {
      fail('Required reaction window truncated or invalid.');
      continue;
    }
    const evidence = relevant.filter((frame) => frame.t >= reaction.start && frame.t <= reaction.end);
    if (!evidence.some((frame) => frame.t === reaction.start) ||
        !evidence.some((frame) => frame.t === reaction.end)) fail('Missing exact reaction boundary evidence.');
    for (const frame of evidence) {
      const layout = [...changes].reverse().find((change) => change.t <= frame.t)?.layout ?? range.layout;
      const visibleReaction = frame.speakers.filter((speaker) => !speaker.speaking &&
        range.faces.some((face) => face.id === speaker.id));
      // Single crops do not prove retention of a listener alongside a speaker.
      if (visibleReaction.length === 0 || (layout === 'single' && frame.speakers.some((speaker) => speaker.speaking))) {
        fail(`Reaction face retention not established at ${frame.frame_id}.`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
