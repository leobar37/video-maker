/**
 * helpers.ts — Lógica PURA del ejemplo `pi-codemode` (sin React, sin red).
 *
 * Responsabilidades:
 *  - Duración de la composición = techo de la voz + cola de cierre; y el
 *    RECHAZO explícito de narraciones de más de 120 s (vertical corto).
 *  - Timeline de escenas derivado del alineamiento REAL (`narration.scenes`),
 *    con fallback proporcional si faltara.
 *  - Palabras por escena con tiempos locales, emparejado por cues y el
 *    escalonado de los `emphasis` del guion.
 *  - Agrupado de subtítulos (bloques cortos de 2 líneas) y tokenización de
 *    código para el panel oscuro.
 */
import type { CodeLine, CodeToken, SubtitleWord } from '../../src';
import type { CodemodeScene, CodemodeScript, NarrationMeta } from './types';

export const FPS = 30;
/** Cola final: la última escena permanece visible ~0.8 s más. */
export const CLOSING_HOLD_FRAMES = 24;
/** Tope duro del vertical: 120 s a 30 fps = 3600 frames, cola incluida. */
export const MAX_DURATION_FRAMES = 120 * FPS;

/**
 * Rechaza narraciones sin duración válida o por encima del tope del vertical.
 * Se invoca desde `calculateMetadata`, de modo que un guion demasiado largo
 * falla el render en vez de producir un corte silenciado.
 */
export function assertNarrationDuration(narration: NarrationMeta): void {
  const duration = narration?.durationSeconds;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Narración sin `durationSeconds` válido; no se puede calcular el vertical.');
  }
  const totalFrames = Math.ceil(duration * FPS) + CLOSING_HOLD_FRAMES;
  if (totalFrames > MAX_DURATION_FRAMES) {
    throw new Error(
      `Duración total ${totalFrames} frames (${(totalFrames / FPS).toFixed(2)}s) supera el máximo de ${MAX_DURATION_FRAMES} frames (${MAX_DURATION_FRAMES / FPS}s) de este vertical.`,
    );
  }
}

/** Duración total = techo de la voz + cola de cierre. Nunca hay minutos fijos. */
export function compositionDurationFrames(narration: NarrationMeta): number {
  assertNarrationDuration(narration);
  return Math.max(1, Math.ceil(narration.durationSeconds * FPS)) + CLOSING_HOLD_FRAMES;
}

export interface SceneSlot {
  scene: CodemodeScene;
  index: number;
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface CodemodeTimeline {
  slots: SceneSlot[];
  /** Frames de contenido (sin la cola de cierre). */
  contentFrames: number;
  /** Frames totales, incluida la cola de cierre. */
  totalFrames: number;
  totalSeconds: number;
}

/**
 * Límites de escena derivados del alineamiento real. Si una escena no trae
 * meta, se le asigna una porción proporcional. Los límites son monótonos y la
 * última escena termina exactamente en el fin de la voz.
 */
export function buildSceneTimeline(script: CodemodeScript, narration: NarrationMeta): CodemodeTimeline {
  assertNarrationDuration(narration);
  const totalSeconds = Math.max(0.05, narration.durationSeconds);
  const metaById: Record<string, NarrationMeta['scenes'][number]> = {};
  for (const entry of narration.scenes) metaById[entry.sceneId] = entry;
  const fallbackShare = totalSeconds / Math.max(1, script.scenes.length);
  let cursor = 0;
  const slots: SceneSlot[] = script.scenes.map((scene, index) => {
    const meta = metaById[scene.id];
    const startSeconds = Math.min(totalSeconds, Math.max(cursor, meta ? Math.max(0, meta.startSeconds) : cursor));
    const desiredEnd = meta ? Math.max(startSeconds + 0.05, meta.endSeconds) : startSeconds + fallbackShare;
    const endSeconds = Math.min(totalSeconds, desiredEnd);
    cursor = endSeconds;
    return {
      scene,
      index,
      startSeconds,
      endSeconds,
      durationSeconds: Math.max(0.05, endSeconds - startSeconds),
      startFrame: Math.round(startSeconds * FPS),
      endFrame: Math.round(endSeconds * FPS),
    };
  });

  const contentFrames = Math.max(1, Math.ceil(totalSeconds * FPS));
  if (slots.length > 0) {
    slots[0]!.startFrame = 0;
    for (let i = 1; i < slots.length; i++) {
      const previous = slots[i - 1]!;
      const slot = slots[i]!;
      slot.startFrame = Math.min(contentFrames - 1, Math.max(previous.endFrame, slot.startFrame));
      slot.endFrame = Math.max(slot.startFrame + 1, slot.endFrame);
    }
    const last = slots[slots.length - 1]!;
    last.endFrame = contentFrames;
    last.startFrame = Math.min(last.startFrame, Math.max(0, contentFrames - 1));
    for (let i = slots.length - 2; i >= 0; i--) {
      const slot = slots[i]!;
      const next = slots[i + 1]!;
      slot.endFrame = Math.min(slot.endFrame, next.startFrame);
      slot.startFrame = Math.min(slot.startFrame, Math.max(0, slot.endFrame - 1));
    }
  }

  return { slots, contentFrames, totalFrames: contentFrames + CLOSING_HOLD_FRAMES, totalSeconds };
}

/** Palabras de una escena, con tiempos LOCALES (segundos dentro de la escena). */
export function sceneWords(narration: NarrationMeta, slot: SceneSlot): SubtitleWord[] {
  const words: SubtitleWord[] = [];
  for (const word of narration.words) {
    if (word.end <= slot.startSeconds || word.start >= slot.endSeconds) continue;
    const start = Math.max(0, word.start - slot.startSeconds);
    const end = Math.min(slot.durationSeconds, word.end - slot.startSeconds);
    words.push({ word: word.word, start, end: Math.max(start + 0.02, end) });
  }
  return words;
}

/** Normaliza para emparejar voz con énfasis/cues: minúsculas, sin tildes ni signos. */
export function normalizeWord(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Longitud del prefijo común entre dos palabras normalizadas. */
function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * Momento (segundos locales) en que se ilumina cada `emphasis` del guion.
 *
 * Se ancla a la palabra real cuando existe un prefijo compartido de ≥6 letras
 * (tolera plurales y participios), pero acotado a un reparto rítmico para que
 * las etapas no se apelotonen al final. Siempre monótono.
 */
export function emphasisRevealSeconds(
  emphasis: readonly string[],
  words: readonly SubtitleWord[],
  sceneDurationSeconds: number,
): number[] {
  const count = emphasis.length;
  if (count === 0) return [];
  const normalized = words.map((word) => normalizeWord(word.word));
  const spread = (index: number) => sceneDurationSeconds * ((index + 1) / (count + 1));
  const times: number[] = [];
  let cursor = -0.05;
  emphasis.forEach((phrase, index) => {
    const tokens = phrase.split(/[^\p{L}\p{N}]+/u).map(normalizeWord).filter((token) => token.length >= 2);
    const key = tokens.slice().sort((a, b) => b.length - a.length)[0] ?? '';
    let found: number | null = null;
    if (key.length > 0) {
      for (let i = 0; i < words.length; i++) {
        const norm = normalized[i]!;
        if (norm.length === 0) continue;
        if (norm === key || commonPrefix(norm, key) >= 6) {
          found = words[i]!.start;
          break;
        }
      }
    }
    const cap = spread(index) + 0.2 * sceneDurationSeconds;
    let at = found === null || found > cap ? spread(index) : Math.min(found, cap);
    at = Math.max(at, cursor + 0.05);
    at = Math.min(at, Math.max(0, sceneDurationSeconds - 0.05));
    times.push(Math.max(0, at));
    cursor = at;
  });
  return times;
}

/** Etapa activa: número de énfasis ya revelados a `seconds`. -1 antes del primero. */
export function stageIndex(times: readonly number[], seconds: number): number {
  let active = -1;
  for (let i = 0; i < times.length; i++) {
    if (seconds >= times[i]! - 0.001) active = i;
    else break;
  }
  return active;
}

export interface CaptionCue {
  words: SubtitleWord[];
  start: number;
  end: number;
}

/**
 * Bloques de subtítulo cortos (≤ `maxWords`, ≤ `maxChars`) para no superar las
 * 2 líneas. Se corta además en fin de frase o pausa larga.
 */
export function captionCues(words: readonly SubtitleWord[], maxWords = 6, maxChars = 40): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let current: SubtitleWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    cues.push({ words: current, start: current[0]!.start, end: current[current.length - 1]!.end + 0.12 });
    current = [];
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = word.start - previous.end;
      const punctuation = /[.!?…]$/.test(previous.word);
      if (gap > 0.45 || punctuation) flush();
    }
    const candidate = [...current, word];
    const chars = candidate.map((entry) => entry.word).join(' ').length;
    if (current.length > 0 && (candidate.length > maxWords || chars > maxChars)) flush();
    current.push(word);
  }
  flush();
  return cues;
}

const KEYWORDS: Record<string, true> = Object.fromEntries(
  ['const', 'let', 'for', 'of', 'in', 'if', 'else', 'return', 'await', 'async', 'function', 'new', 'try', 'catch']
    .map((keyword) => [keyword, true] as const),
);
const TYPE_NAMES: Record<string, true> = Object.fromEntries(
  ['Promise', 'Array', 'Object', 'JSON', 'Number', 'String', 'Boolean', 'Map', 'Set'].map((name) => [name, true] as const),
);
const TOKEN_RE = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|([\s\S])/g;

function tokenizeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    const text = match[0];
    if (match[1]) tokens.push({ text, kind: 'comment' });
    else if (match[2]) tokens.push({ text, kind: 'string' });
    else if (match[3]) tokens.push({ text, kind: 'number' });
    else if (match[4]) {
      const next = line[match.index + text.length];
      const kind: CodeToken['kind'] = KEYWORDS[text] === true
        ? 'keyword'
        : TYPE_NAMES[text] === true
          ? 'type'
          : next === '('
            ? 'function'
            : 'plain';
      tokens.push({ text, kind });
    } else tokens.push({ text, kind: 'plain' });
  }
  return tokens;
}

/** Código del guion → líneas tokenizadas para el panel oscuro. */
export function tokenizeCode(code: readonly string[]): CodeLine[] {
  return code.map((line) => ({ tokens: tokenizeLine(line) }));
}

/** Líneas resaltadas acumuladas para una etapa del énfasis (1-based). */
export function cumulativeLines(steps: readonly (readonly number[])[], stage: number): number[] {
  const active: number[] = [];
  for (let index = 0; index <= stage && index < steps.length; index++) {
    for (const line of steps[index]!) if (!active.includes(line)) active.push(line);
  }
  return active;
}
