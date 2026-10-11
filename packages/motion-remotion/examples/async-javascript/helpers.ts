/**
 * helpers.ts — lógica PURA del ejemplo `async-javascript` (sin React, sin red).
 *
 * Deriva todo desde las props reales ({script, narration, evidence}):
 *  - límites de escena en frames a partir del alineamiento de la narración,
 *  - palabras scene-locales para subtítulos/cues,
 *  - resaltado progresivo de líneas y momentos de aparición de la salida,
 *  - tokenización de código por regex (sólo presentación).
 *
 * Ningún tiempo está codificado en segundos absolutos: las cues se anclan a
 * las palabras habladas, así que un reajuste de la voz mueve la animación con
 * ella. Este archivo NO toca `types.ts` (propiedad de main).
 */
import type { CodeLine, CodeToken, SubtitleWord, TerminalEntry } from '../../src';
import type { AsyncScript, AsyncScene, DemoEvidence, NarrationMeta } from './types';

export const FPS = 30;
/** Cola final: la última escena permanece visible ~1s más. */
export const CLOSING_HOLD_FRAMES = 30;

export type TutorialVideoProps = {
  script: AsyncScript;
  narration: NarrationMeta;
  evidence: DemoEvidence;
};

export interface SceneSlot {
  scene: AsyncScene;
  index: number;
  startSeconds: number;
  endSeconds: number;
  sceneDurationSeconds: number;
  startFrame: number;
  endFrame: number;
}

export interface SceneTimeline {
  masterEndFrame: number;
  totalFrames: number;
  slots: SceneSlot[];
}

/** Duración total = techo de la voz + cola de cierre. Nunca hay 8 min fijos. */
export function compositionDurationFrames(narration: NarrationMeta): number {
  return Math.max(1, Math.ceil(narration.durationSeconds * FPS)) + CLOSING_HOLD_FRAMES;
}

/** Límites de escena derivados del alineamiento real; fallback proporcional. */
export function buildSceneTimeline(script: AsyncScript, narration: NarrationMeta): SceneTimeline {
  const masterEndFrame = Math.max(1, Math.ceil(narration.durationSeconds * FPS));
  const masterEndSeconds = narration.durationSeconds;
  const timingById: Record<string, NarrationMeta['scenes'][number]> = Object.fromEntries(
    narration.scenes.map((timing) => [timing.sceneId, timing] as const),
  );
  const fallbackShare = script.scenes.length > 0 ? masterEndSeconds / script.scenes.length : 0;

  const slots: SceneSlot[] = [];
  let cursorSeconds = 0;
  let cursorFrame = 0;
  script.scenes.forEach((scene, index) => {
    const timing = timingById[scene.id];
    const startSeconds = timing && timing.startSeconds >= cursorSeconds - 0.001 ? timing.startSeconds : cursorSeconds;
    const proposedEnd = timing ? timing.endSeconds : startSeconds + fallbackShare;
    const isLast = index === script.scenes.length - 1;
    const endSeconds = isLast ? masterEndSeconds : Math.max(startSeconds + 0.2, proposedEnd);
    const startFrame = Math.max(cursorFrame, index === 0 ? 0 : Math.round(startSeconds * FPS));
    const endFrame = isLast ? masterEndFrame : Math.max(startFrame + 1, Math.round(endSeconds * FPS));
    slots.push({
      scene,
      index,
      startSeconds,
      endSeconds,
      sceneDurationSeconds: Math.max(0.2, endSeconds - startSeconds),
      startFrame,
      endFrame,
    });
    cursorSeconds = endSeconds;
    cursorFrame = endFrame;
  });

  return { masterEndFrame, totalFrames: masterEndFrame + CLOSING_HOLD_FRAMES, slots };
}

/** Palabras de una escena, con tiempos locales (segundos dentro de la escena). */
export function sceneWords(narration: NarrationMeta, slot: SceneSlot): SubtitleWord[] {
  const { startSeconds, endSeconds } = slot;
  const span = Math.max(0.2, endSeconds - startSeconds);
  return narration.words
    .filter((word) => word.start >= startSeconds - 0.001 && word.start < endSeconds)
    .map((word) => {
      const start = Math.max(0, Math.min(span, word.start - startSeconds));
      const end = Math.max(start + 0.08, Math.min(span, word.end - startSeconds));
      return { word: word.word, start, end };
    });
}

function normalizeWord(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Primera palabra (en orden) que cumple `cue` y no precede a `fromSeconds`. */
export function matchWordTime(cue: RegExp, words: readonly SubtitleWord[], fromSeconds = 0): number | null {
  for (const word of words) {
    if (word.start < fromSeconds - 0.001) continue;
    if (cue.test(normalizeWord(word.word))) return word.start;
  }
  return null;
}

interface FocusStep {
  cue: RegExp;
  lines: number[];
}

/**
 * Pasos de resaltado por escena (1-based, como los números que muestra
 * CodePanel). Cada paso se activa cuando se pronuncia su cue y NO retrocede.
 * Es autoría de contenido, no una abstracción genérica.
 */
const SCENE_STEPS: Record<string, FocusStep[]> = {
  '01-prediccion': [
    { cue: /primero/, lines: [1] },
    { cue: /temporizador/, lines: [2, 3, 4] },
    { cue: /final/, lines: [5] },
  ],
  '02-esperas': [
    { cue: /esperando|red/, lines: [1] },
    { cue: /cafeteria|pedido|mostrador/, lines: [2, 3] },
    { cue: /asincronia|continuar/, lines: [2, 3] },
  ],
  '03-sincrono': [
    { cue: /escribimos|archivo/, lines: [1, 2, 4] },
    { cue: /leemos|leer|readfilesync/, lines: [6, 7] },
    { cue: /sincrono|sync/, lines: [4, 6] },
  ],
  '04-callbacks': [
    { cue: /escritura|writefile|inicia/, lines: [1, 2] },
    { cue: /lectura|leer|readfile|depende/, lines: [3, 4, 5] },
    { cue: /continuar/, lines: [8] },
  ],
  '05-event-loop': [
    { cue: /pila|llamadas|^a$/, lines: [1] },
    { cue: /temporizador|registra|callback/, lines: [2] },
    { cue: /continua|imprime/, lines: [3] },
  ],
  '06-microtareas': [
    { cue: /promesa|then|reaccion/, lines: [3, 4] },
    { cue: /microtarea/, lines: [4] },
    { cue: /sincrono|^a$|^c$/, lines: [1, 6] },
    { cue: /temporizador/, lines: [2] },
  ],
  '07-anidacion': [
    { cue: /^uno$/, lines: [1, 2] },
    { cue: /^dos$/, lines: [3, 4] },
    { cue: /^tres$|indentacion/, lines: [5, 6, 7, 8, 9] },
  ],
  '08-promesa': [
    { cue: /promesa|constructor|representa/, lines: [1, 2, 3] },
    { cue: /temporizador/, lines: [2] },
    { cue: /then|reaccion/, lines: [5, 6] },
  ],
  '09-cadena': [
    { cue: /then|esperamos|devolvemos/, lines: [1, 2, 4] },
    { cue: /return|adorno/, lines: [4, 8] },
    { cue: /^dos$/, lines: [6, 7] },
    { cue: /^tres$/, lines: [10] },
  ],
  '10-errores': [
    { cue: /lanza|error/, lines: [3] },
    { cue: /^catch$|rechazo/, lines: [6, 7] },
    { cue: /exito|omitir|omiten/, lines: [5] },
  ],
  '11-await': [
    { cue: /async|inicio/, lines: [1, 3, 10] },
    { cue: /await/, lines: [4] },
    { cue: /^fuera$/, lines: [11] },
    { cue: /^fin$|try|catch/, lines: [2, 5, 6, 7] },
  ],
  '12-concurrencia': [
    { cue: /secuencial|dos segundos/, lines: [1, 2, 3] },
    { cue: /concurrente|solapan|promise/, lines: [5, 6, 7, 8, 9] },
  ],
  '13-fetch': [
    { cue: /fetch|respuesta/, lines: [2] },
    { cue: /estado|http|^ok$/, lines: [3, 4] },
    { cue: /json|cuerpo/, lines: [6, 7] },
    { cue: /^catch$|fallos/, lines: [8, 9] },
  ],
  '14-cierre': [
    { cue: /sincrono|pila/, lines: [1, 4] },
    { cue: /promesa|reaccion/, lines: [3] },
    { cue: /temporizador/, lines: [2] },
  ],
};

/** Líneas (1-based) resaltadas ahora, según el avance de la narración. */
export function highlightedLines(sceneId: string, seconds: number, words: readonly SubtitleWord[]): number[] {
  const steps = SCENE_STEPS[sceneId];
  if (!steps) return [];
  const active: number[] = [];
  let cursor = 0;
  for (const step of steps) {
    const time = matchWordTime(step.cue, words, cursor);
    if (time === null) continue;
    if (seconds < time) break;
    for (const line of step.lines) if (!active.includes(line)) active.push(line);
    cursor = time + 0.001;
  }
  return active;
}

/**
 * Cues EXPLÍCITOS de salida por escena: anclados a la frase donde el guion
 * explica la salida CORRECTA, localizan cada línea por una secuencia completa
 * de palabras normalizadas (sin artículos) y respetan el orden. Sólo las
 * escenas con lista de salida explícita tienen cue; el resto usa el fallback.
 */
const OUTPUT_CUES: Record<string, { anchor: readonly string[]; matches: readonly (readonly string[])[] }> = {
  '01-prediccion': { anchor: ['el', 'resultado', 'es'], matches: [['a'], ['c'], ['b']] },
  '06-microtareas': { anchor: ['el', 'orden', 'es'], matches: [['a'], ['c'], ['p'], ['b']] },
  '07-anidacion': { anchor: ['salida', 'sigue', 'siendo'], matches: [['uno'], ['dos'], ['tres']] },
  '09-cadena': { anchor: ['salida', 'sigue', 'siendo'], matches: [['uno'], ['dos'], ['tres']] },
  '11-await': { anchor: ['aqui', 'aparece'], matches: [['inicio'], ['fuera'], ['fin']] },
  '14-cierre': { anchor: ['primero', 'se', 'ejecuta'], matches: [['sincrono'], ['sincrono'], ['promesa'], ['temporizador']] },
};

const OUTPUT_MIN_GAP_SECONDS = 0.45;

/** Fin (segundos locales) de la primera aparición contigua de `sequence`. */
function findSequenceEnd(
  words: readonly SubtitleWord[],
  sequence: readonly string[],
  fromSeconds: number,
): number | null {
  const normalized = words.map((word) => normalizeWord(word.word));
  for (let index = 0; index < words.length; index++) {
    if (words[index]!.start < fromSeconds - 0.001) continue;
    let matched = 0;
    while (matched < sequence.length && index + matched < words.length
      && normalized[index + matched] === sequence[matched]) {
      matched += 1;
    }
    if (matched === sequence.length) return words[index + sequence.length - 1]!.start;
  }
  return null;
}

/**
 * Momento (segundos locales) en que aparece cada salida. Con cue se ancla a la
 * frase que explica la salida correcta y localiza cada línea en orden con
 * separación mínima; sin cue, reparto didáctico 65–85%. Siempre monótono.
 */
export function outputRevealSeconds(
  sceneId: string,
  tokens: readonly string[],
  words: readonly SubtitleWord[],
  sceneDurationSeconds: number,
): number[] {
  const cue = OUTPUT_CUES[sceneId];
  const floor = sceneDurationSeconds * 0.65;
  const ceiling = sceneDurationSeconds * 0.85;
  const count = Math.max(1, tokens.length);
  const anchorEnd = cue ? findSequenceEnd(words, cue.anchor, 0) : null;
  let cursor = anchorEnd ?? 0;
  const results: number[] = [];
  tokens.forEach((_, index) => {
    let at: number | null = null;
    if (cue && anchorEnd !== null) {
      const match = cue.matches[index];
      if (match) at = findSequenceEnd(words, match, cursor);
    }
    if (at === null) {
      at = anchorEnd !== null
        ? cursor + OUTPUT_MIN_GAP_SECONDS
        : count === 1
          ? sceneDurationSeconds * 0.75
          : floor + (ceiling - floor) * (index / (count - 1));
    }
    const previous = results[index - 1];
    const bounded = Math.max(at, previous === undefined ? 0.05 : previous + OUTPUT_MIN_GAP_SECONDS);
    const clamped = Math.min(sceneDurationSeconds - 0.05, bounded);
    const final = previous === undefined ? Math.max(0.05, clamped) : Math.max(clamped, previous + 0.05);
    results.push(final);
    cursor = final;
  });
  return results;
}

/** Entradas de terminal scene-locales: comando, luego salidas reales. */
export function terminalEntries(
  sceneId: string,
  outputs: readonly string[],
  words: readonly SubtitleWord[],
  sceneDurationSeconds: number,
): TerminalEntry[] {
  const commandDuration = Math.round(FPS * 0.4);
  const entries: TerminalEntry[] = [
    { text: `node ${sceneId}.mjs`, at: 0, duration: commandDuration, kind: 'command' },
  ];
  const reveals = outputRevealSeconds(sceneId, outputs, words, sceneDurationSeconds);
  outputs.forEach((line, index) => {
    const at = Math.max(commandDuration + 4, Math.round(reveals[index]! * FPS));
    entries.push({ text: line, at, kind: 'output' });
  });
  return entries;
}

const KEYWORDS: Record<string, true> = Object.fromEntries([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'throw', 'new', 'async', 'await',
  'try', 'catch', 'import', 'from', 'export', 'class', 'for', 'of', 'while', 'switch', 'case',
  'default', 'typeof', 'instanceof', 'void', 'delete', 'in', 'do', 'break', 'continue',
].map((keyword) => [keyword, true] as const));
const TYPE_NAMES: Record<string, true> = Object.fromEntries(
  ['Error', 'Promise', 'Array', 'Object', 'JSON', 'Number', 'String', 'Boolean', 'Map', 'Set', 'Response']
    .map((name) => [name, true] as const),
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

/** Código del guion → líneas tokenizadas para `CodePanel`. */
export function tokenizeCode(code: string): CodeLine[] {
  return code.split('\n').map((line) => ({ tokens: tokenizeLine(line) }));
}
