/**
 * placeholder.ts — Props por defecto de la composición (SIN pago, cortas).
 *
 * Sólo sirve para que Remotion pueda registrar y bundlear la composición sin
 * props reales. El pipeline inyecta el `script.json`, la narración y el audio
 * verdaderos por `inputProps`. Aquí hay dos escenas mínimas de referencia.
 */
import type { CodemodeScript, CodemodeVideoProps } from './types';
import type { NarrationMeta } from '../async-javascript/types';

const placeholderScript: CodemodeScript = {
  schemaVersion: 1,
  id: 'pi-codemode-dark',
  title: '¿Piensa o hace ping-pong? Pi + Code Mode',
  language: 'es',
  reviewOnly: true,
  publishingAllowed: false,
  sources: ['https://pi.dev/docs/latest/codemode', 'local://paste-1.md'],
  editorialNotes: ['Placeholder local; los ejemplos son ilustrativos.'],
  scenes: [
    {
      id: '01-hook',
      kind: 'hook',
      kicker: 'EL CUELLO DE BOTELLA',
      title: '¿Piensa o hace ping-pong?',
      narration: '¿Tu agente piensa o solo hace ping-pong?',
      emphasis: ['¿PIENSA?', '¿O HACE PING-PONG?'],
      takeaway: 'Más modelo no siempre es la solución.',
    },
    {
      id: '09-close',
      kind: 'cta',
      kicker: 'PRUÉBALO EN PEQUEÑO',
      title: 'Menos ping-pong. Más trabajo útil.',
      narration: 'Menos ping-pong. Más trabajo útil.',
      emphasis: ['MENOS PING-PONG', 'MÁS TRABAJO ÚTIL'],
      takeaway: 'Empieza con una tarea de solo lectura.',
    },
  ],
};

const placeholderNarration: NarrationMeta = {
  schemaVersion: 1,
  requestFingerprint: 'placeholder',
  voice: {
    voiceId: 'placeholder',
    voiceName: 'Placeholder',
    modelId: 'eleven_v4',
    language: 'es',
    usePvcAsIvc: true,
    voiceSettings: { stability: 0.5, similarity_boost: 0.7 },
  },
  text: '¿Tu agente piensa o solo hace ping-pong? Menos ping-pong. Más trabajo útil.',
  durationSeconds: 5.2,
  wavSha256: 'placeholder',
  scenes: [
    { sceneId: '01-hook', startSeconds: 0, endSeconds: 2.8, durationSeconds: 2.8 },
    { sceneId: '09-close', startSeconds: 2.8, endSeconds: 5.2, durationSeconds: 2.4 },
  ],
  words: [
    { word: '¿Tu', start: 0.1, end: 0.3 },
    { word: 'agente', start: 0.35, end: 0.75 },
    { word: 'piensa', start: 0.8, end: 1.15 },
    { word: 'o', start: 1.2, end: 1.3 },
    { word: 'solo', start: 1.35, end: 1.6 },
    { word: 'hace', start: 1.65, end: 1.95 },
    { word: 'ping-pong?', start: 2.0, end: 2.55 },
    { word: 'Menos', start: 2.9, end: 3.3 },
    { word: 'ping-pong.', start: 3.35, end: 3.95 },
    { word: 'Más', start: 4.1, end: 4.35 },
    { word: 'trabajo', start: 4.4, end: 4.75 },
    { word: 'útil.', start: 4.8, end: 5.1 },
  ],
};

export const defaultCodemodeProps: CodemodeVideoProps = {
  script: placeholderScript,
  narration: placeholderNarration,
};
