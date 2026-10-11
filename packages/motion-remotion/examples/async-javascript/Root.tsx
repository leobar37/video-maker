/**
 * Root.tsx — composiciones del tutorial `javascript-asincrono`.
 *
 * Dos formatos con el MISMO componente y las MISMAS props:
 *   - AsyncJavascriptHorizontal (1920×1080)
 *   - AsyncJavascriptVertical   (1080×1920)
 * 30 fps. La duración sale de la narración real (`ceil(dur·fps)` + cola de
 * cierre) vía `calculateMetadata`; nunca hay un 8 min codificado.
 *
 * La voz es un único `<Audio src={staticFile('narration.wav')} />` sin cortes
 * ni fundidos. Cada escena es una `Sequence` cuyos límites provienen del
 * alineamiento real (`narration.scenes`); la última permanece visible durante
 * la cola de cierre. Todo el código y las salidas derivan de las props.
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { CodePanel, TerminalWindow, tutorialTheme, type SubtitleWord } from '../../src';
import {
  CLOSING_HOLD_FRAMES,
  FPS,
  buildSceneTimeline,
  compositionDurationFrames,
  highlightedLines,
  matchWordTime,
  sceneWords,
  terminalEntries,
  tokenizeCode,
  type SceneSlot,
  type TutorialVideoProps,
} from './helpers';
import type { AsyncScene, DemoEvidence } from './types';
import { defaultTutorialProps } from './placeholder';
import { EventLoopDiagram, HelperNote, PromiseDiagram, SceneFrame, TimelineDiagram } from './visuals';

type EvidenceScene = DemoEvidence['scenes'][number];

const WAIT_HELPER_SCENES: Record<string, true> = { '09-cadena': true, '11-await': true, '12-concurrencia': true };

function sceneDiagram(
  scene: AsyncScene,
  progress: number,
  measurements: { sequentialMs: number; concurrentMs: number } | null,
  portrait: boolean,
  seconds: number,
  words: readonly SubtitleWord[],
) {
  if (scene.visual === 'event-loop') {
    const hasMicrotasks = /Promise|then/.test(scene.code);
    const microAt = matchWordTime(/^despues$/, words);
    const timerAt = matchWordTime(hasMicrotasks ? /^luego$/ : /^cuando$/, words);
    const timerReached = timerAt === null ? progress >= 0.72 : seconds >= timerAt;
    const microReached = microAt === null ? progress >= 0.4 : seconds >= microAt;
    const active = timerReached ? 'timers' : hasMicrotasks && microReached ? 'microtasks' : 'stack';
    return <EventLoopDiagram active={active} hasMicrotasks={hasMicrotasks} portrait={portrait} />;
  }
  if (scene.visual === 'promise') {
    const stage = scene.id.startsWith('10')
      ? progress < 0.3 ? 'pending' : progress < 0.62 ? 'rejected' : 'recovered'
      : progress < 0.4 ? 'pending' : 'fulfilled';
    return <PromiseDiagram stage={stage} portrait={portrait} />;
  }
  if (scene.visual === 'timeline') {
    return <TimelineDiagram
      variant={scene.id.startsWith('12') ? 'measured' : 'conceptual'}
      measurements={measurements}
      portrait={portrait}
    />;
  }
  return null;
}

function SceneBody({
  slot, words, evidenceScene, nodeVersion, portrait, totalFrames, totalScenes, closingHoldFrom,
}: {
  slot: SceneSlot;
  words: readonly SubtitleWord[];
  evidenceScene: EvidenceScene | undefined;
  nodeVersion: string;
  portrait: boolean;
  totalFrames: number;
  totalScenes: number;
  closingHoldFrom?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scene, index, sceneDurationSeconds } = slot;
  const seconds = frame / fps;

  const codeLines = useMemo(() => tokenizeCode(scene.code), [scene.code]);
  const activeLines = highlightedLines(scene.id, seconds, words);
  const outputs = useMemo(
    () => (evidenceScene?.kind === 'executed' && evidenceScene.actualOutput.length > 0
      ? evidenceScene.actualOutput
      : scene.expectedOutput),
    [evidenceScene, scene.expectedOutput],
  );
  const entries = useMemo(
    () => terminalEntries(scene.id, outputs, words, sceneDurationSeconds),
    [scene.id, outputs, words, sceneDurationSeconds],
  );
  const rawMeasurements = evidenceScene?.measurements;
  const measurements = rawMeasurements
    && Number.isFinite(rawMeasurements.sequentialMs)
    && Number.isFinite(rawMeasurements.concurrentMs)
    ? rawMeasurements
    : null;
  const hasTerminal = outputs.length > 0;
  const diagram = sceneDiagram(scene, sceneDurationSeconds > 0 ? Math.min(1, seconds / sceneDurationSeconds) : 0, measurements, portrait, seconds, words);

  const codeColumn = (
    <div style={{
      flex: portrait ? 1.05 : 1.25, minWidth: 0, minHeight: 0,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CodePanel filename={`${scene.id}.mjs`} lines={codeLines} highlightLines={activeLines}
          fontSize={28} />
      </div>
      {WAIT_HELPER_SCENES[scene.id] === true ? <HelperNote portrait={portrait}>
        <b>wait(ms)</b> se define en la escena 08; aquí se reutiliza la misma promesa.
      </HelperNote> : null}
      {scene.id === '13-fetch' ? <HelperNote portrait={portrait}>
        Servidor de prueba · respuestas 200 y 404; sin API externa.
      </HelperNote> : null}
    </div>
  );

  const support = (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: portrait ? 16 : 14 }}>
      {diagram ? <div style={{ flex: 1, minHeight: 0 }}>{diagram}</div> : null}
      {hasTerminal ? <div style={{ flex: diagram ? 1.15 : 1, minHeight: 0 }}>
        <TerminalWindow entries={entries} title={`${scene.id}.mjs`} fontSize={portrait ? 30 : 26} maxRows={8} />
      </div> : null}
    </div>
  );

  return <SceneFrame
    scene={scene} index={index} total={totalScenes}
    startFrame={slot.startFrame} totalFrames={totalFrames} nodeVersion={nodeVersion}
    captionWords={words} closingHoldFrom={closingHoldFrom}
  >
    {codeColumn}
    {support}
  </SceneFrame>;
}

export type { TutorialVideoProps } from './helpers';

export const AsyncJavascriptVideo: React.FC<TutorialVideoProps> = ({ script, narration, evidence }) => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const timeline = useMemo(() => buildSceneTimeline(script, narration), [script, narration]);
  const evidenceById: Record<string, EvidenceScene> = useMemo(
    () => Object.fromEntries(evidence.scenes.map((entry) => [entry.id, entry] as const)),
    [evidence],
  );
  const wordsByScene: Record<string, SubtitleWord[]> = useMemo(
    () => Object.fromEntries(timeline.slots.map((slot) => [slot.scene.id, sceneWords(narration, slot)] as const)),
    [timeline, narration],
  );
  const lastIndex = timeline.slots.length - 1;

  return <AbsoluteFill style={{ background: tutorialTheme.paper }}>
    {timeline.slots.map((slot) => {
      const isLast = slot.index === lastIndex;
      const hold = isLast ? CLOSING_HOLD_FRAMES : 0;
      const durationInFrames = slot.endFrame - slot.startFrame + hold;
      return <Sequence key={slot.scene.id} from={slot.startFrame} durationInFrames={durationInFrames} name={slot.scene.id}>
        <SceneBody
          slot={slot}
          words={wordsByScene[slot.scene.id] ?? []}
          evidenceScene={evidenceById[slot.scene.id]}
          nodeVersion={evidence.nodeVersion}
          portrait={portrait}
          totalFrames={timeline.totalFrames}
          totalScenes={timeline.slots.length}
          closingHoldFrom={isLast ? slot.endFrame - slot.startFrame : undefined}
        />
      </Sequence>;
    })}
    <Audio src={staticFile('narration.wav')} />
  </AbsoluteFill>;
};

export const ASYNC_COMPOSITIONS = [
  { id: 'AsyncJavascriptHorizontal', width: 1920, height: 1080 },
  { id: 'AsyncJavascriptVertical', width: 1080, height: 1920 },
] as const;

export const RemotionRoot: React.FC = () => (
  <>
    {ASYNC_COMPOSITIONS.map((format) => (
      <Composition
        key={format.id}
        id={format.id}
        component={AsyncJavascriptVideo}
        durationInFrames={compositionDurationFrames(defaultTutorialProps.narration)}
        fps={FPS}
        width={format.width}
        height={format.height}
        defaultProps={defaultTutorialProps}
        calculateMetadata={({ props }) => ({ durationInFrames: compositionDurationFrames(props.narration) })}
      />
    ))}
  </>
);
