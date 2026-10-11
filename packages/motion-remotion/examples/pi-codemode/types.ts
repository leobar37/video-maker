/**
 * types.ts — Contratos del ejemplo `pi-codemode`.
 *
 * `CodemodeScript` modela EXACTAMENTE el `script.json` aprobado (sólo lectura):
 * no añade campos ni reinterpreta el guion. `NarrationMeta` se reutiliza del
 * ejemplo hermano `async-javascript` para que main inyecte el MISMO contrato de
 * alineamiento de voz (escenas a tempo real y palabras con start/end).
 */
import type { NarrationMeta } from '../async-javascript/types';

export type { NarrationMeta };

/** Tipos de escena del guion aprobado, en orden narrativo. */
export type CodemodeSceneKind =
  | 'hook'
  | 'pingpong'
  | 'orchestrate'
  | 'code'
  | 'discovery'
  | 'classifier'
  | 'guard'
  | 'roles'
  | 'cta';

/** Una escena del guion. Todos los arrays son de sólo lectura. */
export interface CodemodeScene {
  id: string;
  kind: CodemodeSceneKind;
  kicker: string;
  title: string;
  narration: string;
  emphasis: readonly string[];
  takeaway: string;
  /** Líneas de código ilustrativo (máximo 6). Ausente cuando no aplica. */
  code?: readonly string[];
  /** Etiqueta honesta bajo el código (p. ej. "Fragmento ilustrativo"). */
  codeLabel?: string;
}

/** El `script.json` aprobado, tal cual. */
export interface CodemodeScript {
  schemaVersion: number;
  id: string;
  title: string;
  language: string;
  reviewOnly: boolean;
  publishingAllowed: boolean;
  sources: readonly string[];
  editorialNotes: readonly string[];
  scenes: readonly CodemodeScene[];
}

/**
 * Props de la composición: guion + alineación de voz ya a tempo final.
 * Es un `type` (no `interface`) para que sea asignable a `Record<string, unknown>`
 * como `inputProps` de Remotion, igual que `TutorialVideoProps` del ejemplo hermano.
 */
export type CodemodeVideoProps = {
  script: CodemodeScript;
  narration: NarrationMeta;
};
