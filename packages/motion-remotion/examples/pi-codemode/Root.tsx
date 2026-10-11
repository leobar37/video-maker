/**
 * Root.tsx — Composición `PiCodemodeVertical` (1080×1920, 30 fps).
 *
 * Un único componente consume el `script.json` + la alineación de voz ya a
 * tempo final. La duración sale de `calculateMetadata`: techo de la narración
 * en frames + cola de cierre, y RECHAZA guiones de más de 120 s.
 *
 * La voz es UN único `<Audio src={staticFile('narration.wav')} />`, sin cortes
 * ni fundidos. Cada escena es una `Sequence` cuyos límites provienen de
 * `narration.scenes`; la última permanece visible durante la cola de cierre.
 * Los subtítulos se anclan a las palabras reales; ningún dato es inventado.
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SubtitleWord } from '../../src';
import {
  CLOSING_HOLD_FRAMES,
  FPS,
  buildSceneTimeline,
  compositionDurationFrames,
  emphasisRevealSeconds,
  normalizeWord,
  sceneWords,
  stageIndex,
  tokenizeCode,
  type SceneSlot,
} from './helpers';
import type { CodemodeVideoProps } from './types';
import { defaultCodemodeProps } from './placeholder';
import { theme } from './theme';
import {
  ClassifierVisual,
  CodeVisual,
  CtaVisual,
  DiscoveryVisual,
  GuardVisual,
  HookVisual,
  OrchestrateVisual,
  PingPongVisual,
  RolesVisual,
  SceneFrame,
} from './visuals';

export type { CodemodeVideoProps } from './types';

const ACCENT_BY_KIND: Record<string, string> = {
  hook: theme.cyan,
  pingpong: theme.lime,
  orchestrate: theme.lime,
  code: theme.cyan,
  discovery: theme.cyan,
  classifier: theme.amber,
  guard: theme.amber,
  roles: theme.cyan,
  cta: theme.lime,
};

function emphasisTokenSet(emphasis: readonly string[]): Record<string, true> {
  const tokens: Record<string, true> = {};
  for (const phrase of emphasis) {
    for (const part of phrase.split(/[^\p{L}\p{N}]+/u)) {
      const token = normalizeWord(part);
      if (token.length >= 2) tokens[token] = true;
    }
  }
  return tokens;
}

function sceneVisual(slot: SceneSlot, stage: number): React.ReactNode {
  const scene = slot.scene;
  const lines = scene.code ? tokenizeCode(scene.code) : [];
  const label = scene.codeLabel ?? `fragmento · ${scene.id}.js`;
  switch (scene.kind) {
    case 'hook':
      return <HookVisual stage={stage} />;
    case 'pingpong':
      return <PingPongVisual stage={stage} />;
    case 'orchestrate':
      return <OrchestrateVisual stage={stage} />;
    case 'code':
      return <CodeVisual lines={lines} stage={stage} label={label} />;
    case 'discovery':
      return <DiscoveryVisual stage={stage} lines={lines} label={label} />;
    case 'classifier':
      return <ClassifierVisual stage={stage} />;
    case 'guard':
      return <GuardVisual stage={stage} />;
    case 'roles':
      return <RolesVisual stage={stage} />;
    case 'cta':
      return <CtaVisual stage={stage} />;
    default:
      return null;
  }
}

function SceneBody({ slot, words, totalScenes, totalFrames }: {
  slot: SceneSlot;
  words: readonly SubtitleWord[];
  totalScenes: number;
  totalFrames: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const scene = slot.scene;
  const revealTimes = useMemo(
    () => emphasisRevealSeconds(scene.emphasis, words, slot.durationSeconds),
    [scene.emphasis, words, slot.durationSeconds],
  );
  const stage = stageIndex(revealTimes, seconds);
  const emphasisTokens = useMemo(() => emphasisTokenSet(scene.emphasis), [scene.emphasis]);
  const hideTitle = scene.kind === 'hook' || scene.kind === 'cta';

  return <SceneFrame
    scene={scene}
    index={slot.index}
    total={totalScenes}
    startFrame={slot.startFrame}
    totalFrames={totalFrames}
    captionWords={words}
    emphasisTokens={emphasisTokens}
    hideTitle={hideTitle}
    hideTakeaway={scene.kind === 'cta'}
    accent={ACCENT_BY_KIND[scene.kind] ?? theme.cyan}
  >
    {sceneVisual(slot, stage)}
  </SceneFrame>;
}

export const CodemodeVideo: React.FC<CodemodeVideoProps> = ({ script, narration }) => {
  const timeline = useMemo(() => buildSceneTimeline(script, narration), [script, narration]);
  const lastIndex = timeline.slots.length - 1;

  return <AbsoluteFill style={{ background: theme.bg }}>
    {timeline.slots.map((slot) => {
      const isLast = slot.index === lastIndex;
      const hold = isLast ? CLOSING_HOLD_FRAMES : 0;
      const durationInFrames = Math.max(1, slot.endFrame - slot.startFrame) + hold;
      return <Sequence key={slot.scene.id} from={slot.startFrame} durationInFrames={durationInFrames} name={slot.scene.id}>
        <SceneBody
          slot={slot}
          words={sceneWords(narration, slot)}
          totalScenes={timeline.slots.length}
          totalFrames={timeline.totalFrames}
        />
      </Sequence>;
    })}
    <Audio src={staticFile('narration.wav')} />
  </AbsoluteFill>;
};

export const CODEMODE_COMPOSITION = {
  id: 'PiCodemodeVertical',
  width: 1080,
  height: 1920,
} as const;

export const RemotionRoot: React.FC = () => (
  <Composition
    id={CODEMODE_COMPOSITION.id}
    component={CodemodeVideo}
    durationInFrames={compositionDurationFrames(defaultCodemodeProps.narration)}
    fps={FPS}
    width={CODEMODE_COMPOSITION.width}
    height={CODEMODE_COMPOSITION.height}
    defaultProps={defaultCodemodeProps}
    calculateMetadata={({ props }) => ({ durationInFrames: compositionDurationFrames(props.narration) })}
  />
);
