/**
 * placeholder.ts — props por defecto de las composiciones (NO pago, corto).
 *
 * Sólo sirve para registrar/componer sin props reales. El pipeline inyecta el
 * `script.json`, la narración y la evidencia verdaderos por `inputProps`; aquí
 * hay una única escena de referencia con una narración sintética breve.
 */
import type { AsyncScript, DemoEvidence, NarrationMeta } from './types';
import type { TutorialVideoProps } from './helpers';

const placeholderScript: AsyncScript = {
  schemaVersion: 1,
  id: 'javascript-asincrono',
  title: 'JavaScript asíncrono: entiende el orden de ejecución',
  language: 'es',
  voiceDirection: 'Placeholder local; sin síntesis pagada.',
  scenes: [
    {
      id: '01-prediccion',
      title: 'El orden que no esperabas',
      eyebrow: '01 / PREDICE EL RESULTADO',
      visual: 'code',
      narration: 'Muestra local de referencia. La salida es A, C y B.',
      code: "console.log('A');\nsetTimeout(() => {\n  console.log('B');\n}, 0);\nconsole.log('C');",
      expectedOutput: ['A', 'C', 'B'],
      callout: 'Programar no es ejecutar inmediatamente.',
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
  text: 'Muestra local de referencia. La salida es A, C y B.',
  durationSeconds: 3.8,
  wavSha256: 'placeholder',
  scenes: [{ sceneId: '01-prediccion', startSeconds: 0, endSeconds: 3.8, durationSeconds: 3.8 }],
  words: [
    { word: 'Muestra', start: 0, end: 0.5 },
    { word: 'local', start: 0.55, end: 0.9 },
    { word: 'de', start: 0.95, end: 1.05 },
    { word: 'referencia.', start: 1.1, end: 1.8 },
    { word: 'La', start: 2.0, end: 2.15 },
    { word: 'salida', start: 2.2, end: 2.6 },
    { word: 'es', start: 2.65, end: 2.8 },
    { word: 'A,', start: 2.9, end: 3.05 },
    { word: 'C', start: 3.1, end: 3.25 },
    { word: 'y', start: 3.3, end: 3.4 },
    { word: 'B.', start: 3.45, end: 3.65 },
  ],
};

const placeholderEvidence: DemoEvidence = {
  schemaVersion: 1,
  runtime: 'node',
  nodeVersion: 'v22.14.0',
  verifiedAt: '1970-01-01T00:00:00.000Z',
  scenes: [
    {
      id: '01-prediccion',
      codeSha256: '0'.repeat(64),
      expectedOutput: ['A', 'C', 'B'],
      actualOutput: ['A', 'C', 'B'],
      passed: true,
      kind: 'executed',
    },
  ],
};

export const defaultTutorialProps: TutorialVideoProps = {
  script: placeholderScript,
  narration: placeholderNarration,
  evidence: placeholderEvidence,
};
