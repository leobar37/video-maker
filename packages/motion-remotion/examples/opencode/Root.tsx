import React from 'react';
import { AbsoluteFill, Composition, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  Callout, CodePanel, ScreenRecording, TerminalWindow, TutorialLayout, TutorialPointer,
  tutorialTheme, type CodeLine, type TerminalEntry,
} from '../../src';

import { CHAPTER_FRAMES, DEMO_FPS, DEMO_FRAMES, DEMO_FORMATS } from './config';

const launch: TerminalEntry[] = [
  { text: '# Trabaja desde la carpeta de tu proyecto', at: 12, kind: 'comment' },
  { text: 'cd mi-proyecto', at: 28, duration: 32, kind: 'command' },
  { text: 'opencode', at: 78, duration: 36, kind: 'command' },
  { text: 'A continuación: describe el cambio que necesitas.', at: 144, kind: 'comment' },
];
const request: TerminalEntry[] = [
  { text: '# Ejemplo de petición al asistente', at: 8, kind: 'comment' },
  { text: 'Añade un saludo personalizado\ny un valor por defecto.', at: 24, duration: 65, kind: 'command' },
  { text: '\nRevisa el diff antes de continuar.', at: 120, kind: 'comment' },
];
const code: CodeLine[] = [
  { tokens: [{ text: '// Un cambio pequeño, fácil de revisar', kind: 'comment' }] },
  { tokens: [] },
  { change: 'added', tokens: [
    { text: 'export function ', kind: 'keyword' }, { text: 'greet', kind: 'function' }, { text: '(' },
  ] },
  { change: 'added', tokens: [
    { text: '  name', kind: 'plain' }, { text: ' = ' }, { text: '"mundo"', kind: 'string' },
  ] },
  { change: 'added', tokens: [{ text: ') {' }] },
  { change: 'added', tokens: [
    { text: '  return ', kind: 'keyword' }, { text: '`Hola, ${name}`', kind: 'string' }, { text: ';' },
  ] },
  { change: 'added', tokens: [{ text: '}' }] },
  { tokens: [] },
  { tokens: [{ text: 'greet', kind: 'function' }, { text: '(' }, { text: '"Elena"', kind: 'string' }, { text: ');' }] },
];

function LaunchScene() {
  const { width, height } = useVideoConfig();
  return <TutorialLayout eyebrow="01 / TERMINAL ANIMADA" step="01 — 04"
    title="Todo empieza con una instrucción."
    description="Comandos legibles. Escritura progresiva. Tiempo para entender cada paso."
    aside={<Callout number="01" title="Sin ruido visual" from={50}>Un comando a la vez, con cursor y pausas que acompañan la explicación.</Callout>}>
    <TerminalWindow entries={launch} title="~/mi-proyecto" fontSize={height > width ? 34 : 32} />
  </TutorialLayout>;
}

function CodeScene() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return <TutorialLayout eyebrow="02 / CÓDIGO + CONTEXTO" step="02 — 04"
    title="Del prompt al cambio concreto."
    description="La petición y el resultado, juntos. Resalta exactamente lo que estás explicando.">
    <div style={{ display: 'grid', gridTemplateColumns: portrait ? '1fr' : '1.14fr 1fr',
      gridTemplateRows: portrait ? '1.1fr 1fr' : '1fr', gap: 30, height: '100%', minHeight: 0 }}>
      <CodePanel filename="src/greet.ts" lines={code} highlightLines={frame > 70 ? [4, 6] : []} fontSize={portrait ? 30 : 27} />
      <div style={{ position: 'relative', height: '100%', minHeight: 0 }}>
        <TerminalWindow entries={request} title="Petición · ejemplo ilustrativo" fontSize={portrait ? 32 : 25} />
        {frame > 125 && <TutorialPointer x={10} y={72} label="Petición → diff → revisión" />}
      </div>
    </div>
  </TutorialLayout>;
}

function VideoScene() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const sampleVideo = DEMO_FORMATS[portrait ? 'vertical' : 'horizontal'].sampleVideo;
  const zoom = interpolate(frame, [50, 105, 180, 230], [1, 1.14, 1.14, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return <TutorialLayout eyebrow="03 / VIDEO + FOCO" step="03 — 04"
    title="La pantalla también cuenta la historia."
    description="Video integrado, zoom dirigido y anotaciones sin ocultar lo importante."
    aside={<Callout number="03" title="Tu grabación, aquí" from={35}>Este MP4 es una muestra generada. Se puede sustituir por una captura real de OpenCode.</Callout>}>
    <ScreenRecording src={staticFile(sampleVideo)} title={sampleVideo} badge="VIDEO ILUSTRATIVO"
      zoom={zoom} focus={{ x: 25, y: 35 }}
      overlay={frame > 100 ? <TutorialPointer x={portrait ? 12 : 57} y={69} label="Zoom sobre el detalle" /> : undefined} />
  </TutorialLayout>;
}

function SummaryScene() {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const finalEntries: TerminalEntry[] = [
    { text: 'bun test', at: 10, duration: 28, kind: 'command' },
    { text: '# Aquí mostraríamos el resultado real', at: 65, kind: 'comment' },
    { text: '# de las pruebas del proyecto.', at: 80, kind: 'comment' },
  ];
  return <TutorialLayout eyebrow="04 / UN KIT, MUCHOS TUTORIALES" step="04 — 04"
    title="Explica. Demuestra. Repite."
    description="Componentes reutilizables para construir una serie, no solo un video."
    aside={<Callout number="04" title="Listo para tu contenido" from={20}>Terminal, código, video y anotaciones. Una misma identidad en horizontal y vertical.</Callout>}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}><TerminalWindow entries={finalEntries} title="Verificación · ejemplo" fontSize={portrait ? 34 : 28} /></div>
      <div style={{ display: 'grid', gridTemplateColumns: portrait ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 12 }}>
        {['TERMINAL', 'CÓDIGO', 'VIDEO', 'CALLOUTS'].map((label, i) => <div key={label} style={{
          padding: '22px 18px', borderTop: `2px solid ${tutorialTheme.accent}`, color: tutorialTheme.ink,
          fontFamily: tutorialTheme.mono, fontSize: portrait ? 24 : 19,
        }}><span style={{ color: tutorialTheme.accent, marginRight: 16 }}>0{i + 1}</span>{label}</div>)}
      </div>
    </div>
  </TutorialLayout>;
}

export function OpenCodeDemo() {
  return <AbsoluteFill>
    {[LaunchScene, CodeScene, VideoScene, SummaryScene].map((Scene, index) => (
      <Sequence key={index} from={index * CHAPTER_FRAMES} durationInFrames={CHAPTER_FRAMES}>
        <Scene />
      </Sequence>
    ))}
  </AbsoluteFill>;
}

/** This locally rendered fixture exercises actual MP4 decoding, without external media. */
function TerminalSample() {
  return <AbsoluteFill style={{ background: tutorialTheme.dark, padding: 38 }}>
    <TerminalWindow title="Muestra de video · contenido ilustrativo" fontSize={38} entries={[
      { text: '# Captura de ejemplo para probar el componente', at: 10, kind: 'comment' },
      { text: 'opencode', at: 30, duration: 45, kind: 'command' },
      { text: '\nDescribe una tarea pequeña y concreta.', at: 100, kind: 'output' },
      { text: 'Revisa los cambios antes de aplicarlos.', at: 150, kind: 'output' },
    ]} />
  </AbsoluteFill>;
}

export function RemotionRoot() {
  return <>
    {Object.values(DEMO_FORMATS).map((format) => <React.Fragment key={format.compositionId}>
      <Composition id={format.compositionId} component={OpenCodeDemo} durationInFrames={DEMO_FRAMES}
        fps={DEMO_FPS} width={format.width} height={format.height} />
      <Composition id={format.sampleId} component={TerminalSample} durationInFrames={CHAPTER_FRAMES}
        fps={DEMO_FPS} width={format.sampleWidth} height={format.sampleHeight} />
    </React.Fragment>)}
  </>;
}
