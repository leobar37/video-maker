/**
 * Registro de presets de voz — multi-proveedor.
 *
 * Cada preset fija la identidad (voice ID o voz clonada/preset) Y su
 * calibración. Regla origen: «Calibración estándar de la voz» — una voz se
 * calibra, no se reemplaza.
 *
 * Proveedores soportados (bake-off 2026-09-22/23):
 * - `elevenlabs`   — directo vía API de ElevenLabs (calidad techo, otro vendor).
 * - `minimax-fal`  — voz clonada en MiniMax 2.8 HD vía fal.ai (`custom_voice_id`
 *                    efímero que expira a los 7 días sin uso).
 * - `fal-preset`   — preset de sistema de MiniMax vía fal.ai (p. ej.
 *                    `Lively_Girl`): fluido, genérico, sin expiración.
 *
 * **El repo no guarda bytes de audio.** Las muestras y la referencia de
 * re-clon viven en el R2 de Elena Tech (`media.theelena.me/voices/<preset>/…`)
 * y cada preset registra aquí solo su URL + sha256 (`assets`).
 *
 * `video.json` sigue llevando los valores explícitos (voiceId, modelId,
 * voiceSettings) para que cada video sea auditable sin resolver el preset;
 * este registro es la fuente del nombre, la calibración y la estrategia de
 * preservación.
 */

import { MediaProviderError } from './common';

/** Un activo de audio del preset, ya residente en R2 (nunca en el repo). */
export interface VoiceAssetRef {
  /** Nombre corto con el que se registra la muestra (take-13, reference…). */
  name: string;
  /** URL pública en R2 (https://media.theelena.me/voices/…). */
  url: string;
  /** sha256 del archivo subido — identidad de los bytes servidos. */
  sha256: string;
  /** Qué es esta muestra y por qué quedó registrada. */
  note?: string;
}

export interface VoiceAssets {
  /** Audio fuente para re-clonar (voces clonadas). La voz nunca depende del ID efímero. */
  reference?: VoiceAssetRef;
  /** Muestras audibles para decidir — bake-off y calibraciones. */
  auditions: readonly VoiceAssetRef[];
}

interface VoicePresetBase {
  /** Alias corto con el que se nombra en docs, audiciones y CLI. */
  id: string;
  /** Nombre humano para metadata. */
  label: string;
  language: string;
  /** Cómo sobrevive la voz a la muerte del vendor/ID. Obligatoria por diseño. */
  preservation: string;
  /** Por qué está calibrado así — sobrevive al que lo eligió. */
  note: string;
  assets: VoiceAssets;
}

/** ElevenLabs directo (voz de marca: Memo). */
export interface ElevenLabsVoicePreset extends VoicePresetBase {
  provider: 'elevenlabs';
  voiceId: string;
  voiceName: string;
  modelId: string;
  voiceSettings: {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
    speed: number;
  };
}

/** Calibración común de las voces MiniMax (speech-2.8-hd vía fal.ai). */
export interface MinimaxCalibration {
  /** 0.5–2.0. */
  speed: number;
  /** −12–12: controla la deriva de edad entre generaciones del clon. */
  pitch: number;
  /** 0–10. */
  vol: number;
  /** `language_boost` del modelo — fija la pronunciación Latam. */
  languageBoost: 'Spanish';
}

/** Voz clonada en MiniMax 2.8 HD vía fal.ai. */
export interface MinimaxFalVoicePreset extends VoicePresetBase {
  provider: 'minimax-fal';
  /** Endpoint fal del modelo (cola). */
  modelId: string;
  endpoint: string;
  /**
   * `custom_voice_id` del clon — **caché efímera**: expira a los 7 días sin
   * uso. Ausente = re-clonar desde `assets.reference` (keep-alive semanal
   * opcional). La fuente de verdad es siempre el audio de referencia.
   */
  customVoiceId?: string;
  /** Preset del que deriva este clon. */
  cloneOf: string;
  calibration: MinimaxCalibration;
}

/** Preset de sistema de MiniMax vía fal.ai (sin clon, sin expiración). */
export interface FalPresetVoicePreset extends VoicePresetBase {
  provider: 'fal-preset';
  modelId: string;
  endpoint: string;
  /** Voz del sistema del modelo (p. ej. `Lively_Girl`). */
  voiceId: string;
  calibration: MinimaxCalibration;
}

export type VoicePreset = ElevenLabsVoicePreset | MinimaxFalVoicePreset | FalPresetVoicePreset;

/** Mapa clave → preset: `resolveVoicePreset('memo-v3')` devuelve su variante tipada. */
export type VoicePresetMap = {
  'memo-v3': ElevenLabsVoicePreset;
  'rafael-hulk-v3': ElevenLabsVoicePreset;
  'memo-minimax-clone': MinimaxFalVoicePreset;
  'lively-girl': FalPresetVoicePreset;
};

export type VoicePresetId = keyof VoicePresetMap;

const MINIMAX_MODEL = 'fal-ai/minimax/speech-2.8-hd';
const MINIMAX_ENDPOINT = `https://queue.fal.run/${MINIMAX_MODEL}`;

export const VOICE_PRESETS: VoicePresetMap = {
  'memo-v3': {
    id: 'memo-v3',
    label: 'Memo M · eleven_v3 (neutral LATAM, natural)',
    provider: 'elevenlabs',
    voiceId: 'FTFn0f40lQFQlsDC71tR',
    voiceName: 'Memo M - Professional Latin American Spanish (calibrado v3)',
    modelId: 'eleven_v3',
    language: 'es',
    voiceSettings: {
      stability: 0.7,
      similarity_boost: 0.5,
      style: 0,
      use_speaker_boost: true,
      speed: 1.0,
    },
    preservation:
      'Cuenta ElevenLabs mínima mantenida solo para esta voz (estrategia de marca). ' +
      'Si ElevenLabs desaparece, la identidad de Memo se reclona en MiniMax desde ' +
      'la referencia de `memo-minimax-clone`.',
    note:
      'Calibración estándar desde 2026-09-18 (episodio edu/02). El preset anterior ' +
      '(multilingual_v2 con stability 0.45 / style 0.15 / speed 1.06) dejaba al modelo ' +
      'actuar el doble de lo que la voz pide — su stability de diseño es 1.0 — y producía ' +
      'saltos de voz en preguntas. A/B con la frase real en el bake-off 2026-09-22 ' +
      '(variantes A–E). Muestra `bakeoff-01-baseline`: guion del bake-off con ' +
      'eleven_multilingual_v2 (referencia histórica, no la calibración v3).',
    assets: {
      auditions: [
        {
          name: 'bakeoff-01-baseline',
          url: 'https://media.theelena.me/voices/memo-v3/bakeoff-01-baseline.mp3',
          sha256: '29d1cb4ae4265693f9aae6edfa09daabafeb67165d25ddba3d4becdf28cf2d95',
          note: 'Bake-off 2026-09-22 baseline (eleven_multilingual_v2).',
        },
      ],
    },
  },
  'rafael-hulk-v3': {
    id: 'rafael-hulk-v3',
    label: 'Rafael Hulk · eleven_v3 (gigante verde: grave, monumental, noble)',
    provider: 'elevenlabs',
    voiceId: 'HsUXjBKowexoC3ay3tS2',
    voiceName: 'Rafael Hulk',
    modelId: 'eleven_v3',
    language: 'es',
    voiceSettings: {
      stability: 0.7,
      similarity_boost: 0.5,
      style: 0,
      use_speaker_boost: true,
      speed: 1.0,
    },
    preservation:
      'Voz GENERADA con Voice Design (category generated): el voice_id es permanente ' +
      'en la cuenta ElevenLabs, no un clon efímero. Si ElevenLabs desaparece, la ' +
      'identidad se reclona en MiniMax desde audio de referencia; al primer audition ' +
      'real del personaje, subir esa referencia a R2 y registrarla en `assets.reference`.',
    note:
      'Diseñada 2026-09 con Voice Design: "extremely deep, gravelly, monstrous male ' +
      'giant voice, thunderous, menacing yet noble". La calibración de arriba es la ' +
      'estándar v3 PROVISIONAL (no hay A/B todavía): audicionar SIEMPRE un párrafo ' +
      'del guion real antes de producir y registrar aquí las muestras y la ' +
      'calibración definitiva. Los videos de rafael nacen con `tts.mode: "continuous"` ' +
      '— UNA voz para todo el master.',
    // Sin assets todavía: las muestras de Voice Design viven en scratch local
    // gitignored; el flujo de audition es el que sube a R2 y registra URL + sha256.
    assets: {
      auditions: [],
    },
  },
  'memo-minimax-clone': {
    id: 'memo-minimax-clone',
    label: 'Memo clonado · MiniMax 2.8 HD vía fal (speed 1.1×, pitch fijo)',
    provider: 'minimax-fal',
    modelId: MINIMAX_MODEL,
    endpoint: MINIMAX_ENDPOINT,
    language: 'es',
    // customVoiceId se anota aquí al clonar (caché efímera de 7 días sin uso).
    cloneOf: 'memo-v3',
    calibration: { speed: 1.1, pitch: 0, vol: 1, languageBoost: 'Spanish' },
    preservation:
      'La fuente de verdad es el audio de referencia (40 s) respaldado en R2 y ' +
      'registrado en `assets.reference`; el `custom_voice_id` es caché renovable: ' +
      'keep-alive semanal o re-clon bajo demanda con fal-ai/minimax/voice-clone ' +
      'cuando expire. La deriva de edad entre generaciones se controla con ' +
      'take múltiple + pitch fijo (take-16 = pitch +2 compensa deriva hacia voz vieja).',
    note:
      'Bake-off 2026-09-22/23: aceptable como reemplazo económico de Memo — takes ' +
      'ganadores 13 (guion corto + speed 1.1×), 14 (take A, pitch 0) y 16 ' +
      '(pitch +2, más joven). Variante rápida validada: speed 1.1×. ' +
      'language_boost Spanish fija la pronunciación Latam.',
    assets: {
      reference: {
        name: 'reference',
        url: 'https://media.theelena.me/voices/memo-minimax-clone/reference.mp3',
        sha256: '424508cfe1578665ebf732421403f1218ae065098508047fa2bcfd62b639403c',
        note: 'Referencia de re-clon (40 s): fuente de verdad del clon de Memo.',
      },
      auditions: [
        {
          name: 'take-13',
          url: 'https://media.theelena.me/voices/memo-minimax-clone/take-13.mp3',
          sha256: 'f18ec13a82786b2392d9ce5202beffce1913fd16330ff9dc0ad945f7f16d2a81',
          note: 'Bake-off take 13 (ganador): guion corto + speed 1.1×.',
        },
        {
          name: 'take-14',
          url: 'https://media.theelena.me/voices/memo-minimax-clone/take-14.mp3',
          sha256: '8b2bbd6cdffd8252c879f30933cf96f04fd46a7622481333831431fbf2945757',
          note: 'Bake-off take 14 (ganador): take A, pitch 0.',
        },
        {
          name: 'take-16',
          url: 'https://media.theelena.me/voices/memo-minimax-clone/take-16.mp3',
          sha256: '38bc3a47a2aa6904a1ff8ceb38d114a40cb4ff68ae19c05e1e9c06854616bd17',
          note: 'Bake-off take 16 (ganador): pitch +2 compensa deriva hacia voz vieja.',
        },
      ],
    },
  },
  'lively-girl': {
    id: 'lively-girl',
    label: 'Lively_Girl · MiniMax 2.8 HD preset (marketing social, energía joven)',
    provider: 'fal-preset',
    modelId: MINIMAX_MODEL,
    endpoint: MINIMAX_ENDPOINT,
    voiceId: 'Lively_Girl',
    language: 'es',
    calibration: { speed: 1.1, pitch: 0, vol: 1, languageBoost: 'Spanish' },
    preservation:
      'Preset de sistema del modelo (no clon): sin problema de derechos ni de ' +
      'expiración — siempre resoluble con el mismo `voice_id` mientras exista el modelo.',
    note:
      'Bake-off 2026-09-22/23, take 20 (speed 1.1×, boost español): fluida y genérica, ' +
      'con energía social-media. Para piezas de marketing femeninas/jóvenes donde ' +
      'Memo no es necesario.',
    assets: {
      auditions: [
        {
          name: 'take-20',
          url: 'https://media.theelena.me/voices/lively-girl/take-20.mp3',
          sha256: 'f90dd53d9658f1118d3715919e0065de5687ada2cdd622a09c76ef656be687a2',
          note: 'Bake-off take 20 (ganador): Lively_Girl speed 1.1× boost español.',
        },
      ],
    },
  },
};

export const VOICE_PRESET_IDS = Object.keys(VOICE_PRESETS) as VoicePresetId[];

/** Devuelve el preset de voz por nombre; falla con la lista de conocidos. */
export function resolveVoicePreset<K extends VoicePresetId>(name: K): VoicePresetMap[K];
export function resolveVoicePreset(name: string): VoicePreset;
export function resolveVoicePreset(name: string): VoicePreset {
  const preset = (VOICE_PRESETS as Record<string, VoicePreset>)[name];
  if (!preset) {
    throw new MediaProviderError(
      'UNSUPPORTED_CAPABILITY',
      `Preset de voz desconocido "${name}". Conocidos: ${Object.keys(VOICE_PRESETS).join(', ')}.`,
    );
  }
  return preset;
}
