/**
 * visuals.tsx — componentes de presentación del ejemplo `async-javascript`.
 *
 * Reutiliza el tema + `DesktopWindow` del kit y aporta: marco editorial por
 * escena (encabezado, progreso, idea clave, subtítulo de frase, pie honesto),
 * diagramas semánticos (event loop, promesa, timeline medida) y captions
 * por frase. Nada aquí inventa runtime ni capturas: sólo recorre la evidencia.
 */
import { useMemo, type ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { tutorialTheme, type SubtitleWord } from '../../src';
import type { AsyncScene } from './types';

const INK = tutorialTheme.ink;
const MUTED = tutorialTheme.muted;
const ACCENT = tutorialTheme.accent;
const LIME = tutorialTheme.lime;
const ARROW_STYLE = {
  color: tutorialTheme.quietText, fontFamily: tutorialTheme.mono, fontSize: 15,
} as const;

export function NodeBadge({ nodeVersion, portrait }: { nodeVersion: string; portrait: boolean }) {
  return <span style={{
    fontFamily: tutorialTheme.mono, fontSize: portrait ? 16 : 14, letterSpacing: 0.5,
    color: ACCENT, background: '#116B5014', border: `1px solid ${ACCENT}55`,
    borderRadius: 999, padding: portrait ? '5px 12px' : '4px 10px', whiteSpace: 'nowrap',
  }}>Node {nodeVersion}</span>;
}

function CalloutRow({ text, portrait }: { text: string; portrait: boolean }) {
  return <div style={{
    display: 'flex', alignItems: 'flex-start', gap: 16, marginTop: portrait ? 18 : 14,
    borderLeft: `4px solid ${ACCENT}`, paddingLeft: 18,
  }}>
    <span style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 17 : 15, color: ACCENT, paddingTop: 5, letterSpacing: 1 }}>
      IDEA CLAVE
    </span>
    <span style={{ fontSize: portrait ? 27 : 24, fontWeight: 600, lineHeight: 1.34, color: INK }}>{text}</span>
  </div>;
}

interface PhraseCue { words: SubtitleWord[]; start: number; end: number }

function phraseCues(words: readonly SubtitleWord[], maxWords = 6, maxChars = 46): PhraseCue[] {
  const cues: PhraseCue[] = [];
  let current: SubtitleWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    cues.push({ words: current, start: current[0]!.start, end: current[current.length - 1]!.end + 0.3 });
    current = [];
  };
  for (const word of words) {
    const candidate = [...current, word];
    const chars = candidate.map((entry) => entry.word).join(' ').length;
    if (current.length > 0 && (candidate.length > maxWords || chars > maxChars)) flush();
    current.push(word);
  }
  flush();
  return cues;
}

/** Subtítulo por frase (una línea, no muro de texto) desde la narración real. */
function CaptionRow({ words, seconds, portrait }: { words: readonly SubtitleWord[]; seconds: number; portrait: boolean }) {
  const cues = useMemo(() => phraseCues(words), [words]);
  const active = cues.find((cue) => seconds >= cue.start && seconds <= cue.end);
  const height = portrait ? 48 : 40;
  return <div style={{ height, display: 'flex', alignItems: 'center', gap: '0.35em', marginTop: 8,
    fontSize: portrait ? 30 : 27, fontFamily: tutorialTheme.sans, fontWeight: 600 }}>
    {active?.words.map((word, index) => {
      const spoken = seconds >= word.start;
      const isActive = spoken && seconds <= word.end + 0.15;
      return <span key={`${word.start}:${index}`} style={{
        color: isActive ? ACCENT : MUTED,
        transition: 'none', borderBottom: isActive ? `2px solid ${LIME}` : '2px solid transparent', paddingBottom: 2,
      }}>{word.word}</span>;
    })}
  </div>;
}

function ClosingBadge({ fromFrame }: { fromFrame: number }) {
  const frame = useCurrentFrame();
  const show = interpolate(frame, [fromFrame, fromFrame + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', opacity: show }}>
    <span style={{
      fontFamily: tutorialTheme.mono, letterSpacing: 4, fontSize: 22, color: tutorialTheme.lightText,
      background: '#162D29E6', borderRadius: 999, padding: '14px 34px',
    }}>FIN · JAVASCRIPT ASÍNCRONO</span>
  </AbsoluteFill>;
}

export interface SceneFrameProps {
  scene: AsyncScene;
  index: number;
  total: number;
  startFrame: number;
  totalFrames: number;
  nodeVersion: string;
  captionWords: readonly SubtitleWord[];
  closingHoldFrom?: number;
  children: ReactNode;
}

export function SceneFrame({
  scene, index, total, startFrame, totalFrames, nodeVersion, captionWords, closingHoldFrom, children,
}: SceneFrameProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const seconds = frame / fps;
  const enter = interpolate(frame, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const overall = Math.min(1, (startFrame + frame) / Math.max(1, totalFrames));
  const chapter = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;

  return <AbsoluteFill style={{
    background: tutorialTheme.paper, color: INK, fontFamily: tutorialTheme.sans,
    padding: portrait ? '56px 56px 40px' : '38px 64px 28px', display: 'flex', flexDirection: 'column',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingBottom: 14 }}>
      <span style={{ fontSize: portrait ? 22 : 20, fontWeight: 700, letterSpacing: 3 }}>
        JAVASCRIPT ASÍNCRONO <span style={{ color: ACCENT }}>/ {scene.id}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <NodeBadge nodeVersion={nodeVersion} portrait={portrait} />
        <span style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 22 : 19, color: MUTED }}>{chapter}</span>
      </span>
    </div>
    <div style={{ height: 4, borderRadius: 2, background: '#DCE2D6', overflow: 'hidden', marginBottom: 18 }}>
      <div style={{ height: '100%', width: `${overall * 100}%`, background: ACCENT }} />
    </div>
    <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * 14}px)` }}>
      <div style={{ color: ACCENT, fontSize: portrait ? 20 : 18, fontWeight: 700, letterSpacing: 3 }}>{scene.eyebrow}</div>
      <h1 style={{ fontSize: portrait ? 46 : 44, fontWeight: 700, letterSpacing: -1.5, lineHeight: 1.08, margin: '8px 0 0' }}>
        {scene.title}
      </h1>
    </div>
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: portrait ? 'column' : 'row',
      gap: portrait ? 22 : 26, marginTop: portrait ? 22 : 18,
    }}>{children}</div>
    <CalloutRow text={scene.callout} portrait={portrait} />
    {captionWords.length > 0 ? <CaptionRow words={captionWords} seconds={seconds} portrait={portrait} /> : null}
    <div style={{
      display: 'flex', flexDirection: portrait ? 'column' : 'row', gap: 8, justifyContent: 'space-between',
      borderTop: `1px solid ${tutorialTheme.border}`, paddingTop: 12, fontSize: portrait ? 16 : 14,
      letterSpacing: 1, color: MUTED,
    }}>
      <span>Demos verificadas en Node {nodeVersion} · Recorrido visual ilustrativo</span>
      <span style={{ fontFamily: tutorialTheme.mono }}>{width}×{height} · {fps} FPS</span>
    </div>
    {closingHoldFrom !== undefined && frame >= closingHoldFrom ? <ClosingBadge fromFrame={closingHoldFrom} /> : null}
  </AbsoluteFill>;
}

/** Nota pequeña para explicar de dónde sale un helper reutilizado. */
export function HelperNote({ children, portrait }: { children: ReactNode; portrait: boolean }) {
  return <div style={{
    marginTop: 12, display: 'flex', gap: 10, alignItems: 'flex-start',
    background: '#116B500F', border: `1px solid ${ACCENT}33`, borderRadius: 12,
    padding: portrait ? '12px 16px' : '10px 14px', color: MUTED, fontSize: portrait ? 19 : 17, lineHeight: 1.4,
  }}>
    <span style={{ color: ACCENT, fontFamily: tutorialTheme.mono }}>i</span>
    <span>{children}</span>
  </div>;
}

function DiagramPanel({ title, children }: { title: string; children: ReactNode }) {
  return <div style={{
    height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 18,
    background: tutorialTheme.dark, border: '1px solid #31483F', overflow: 'hidden',
  }}>
    <div style={{
      height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px',
      background: tutorialTheme.darkRaised, borderBottom: '1px solid #31483F',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: LIME }} />
      <span style={{ fontFamily: tutorialTheme.mono, fontSize: 16, letterSpacing: 1, color: tutorialTheme.quietText }}>{title}</span>
    </div>
    <div style={{ flex: 1, minHeight: 0, padding: 18, display: 'flex' }}>{children}</div>
  </div>;
}

function LoopBox({ label, note, items, active, portrait }: {
  label: string; note: string; items: readonly string[]; active: boolean; portrait: boolean;
}) {
  return <div style={{
    flex: 1, minWidth: 0, borderRadius: 12, padding: '12px 12px', display: 'flex', flexDirection: 'column', gap: 8,
    border: `1.5px solid ${active ? LIME : '#31483F'}`, background: active ? '#D6EF961A' : '#1C332D',
  }}>
    <div style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 15 : 13, letterSpacing: 0.5,
      color: active ? LIME : tutorialTheme.quietText }}>{label}</div>
    <div style={{ fontSize: portrait ? 13 : 12, color: tutorialTheme.quietText }}>{note}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
      {items.map((item) => <span key={item} style={{
        fontFamily: tutorialTheme.mono, fontSize: portrait ? 15 : 14, color: tutorialTheme.lightText,
        background: '#0F1C19', borderRadius: 6, padding: '5px 8px', overflowWrap: 'anywhere',
      }}>{item}</span>)}
    </div>
  </div>;
}

export function EventLoopDiagram({ active, hasMicrotasks, portrait }: {
  active: 'stack' | 'microtasks' | 'timers'; hasMicrotasks: boolean; portrait: boolean;
}) {
  const boxes = [
    { key: 'stack' as const, label: 'Pila de llamadas', note: 'código síncrono', items: ['console.log("A")', 'console.log("C")'] },
    { key: 'microtasks' as const, label: 'Microtareas', note: 'promesas · then', items: hasMicrotasks ? ['Promise.then → P'] : ['(vacío por ahora)'] },
    { key: 'timers' as const, label: 'Cola de tareas', note: 'setTimeout', items: ['setTimeout → B'] },
  ];
  return <DiagramPanel title="Event loop · navegador (simplificado)">
    <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
      {boxes.map((box) => <LoopBox key={box.key} label={box.label} note={box.note} items={box.items}
        active={active === box.key} portrait={portrait} />)}
    </div>
  </DiagramPanel>;
}

function PromisePill({ label, active, tone, portrait }: {
  label: string; active: boolean; tone: 'idle' | 'ok' | 'bad'; portrait: boolean;
}) {
  const color = tone === 'ok' ? LIME : tone === 'bad' ? '#F0AC9B' : tutorialTheme.quietText;
  return <span style={{
    fontFamily: tutorialTheme.mono, fontSize: portrait ? 20 : 18, letterSpacing: 0.5,
    color: active ? color : tutorialTheme.quietText, background: active ? '#D6EF961A' : '#1C332D',
    border: `1.5px solid ${active ? color : '#31483F'}`, borderRadius: 999,
    padding: portrait ? '10px 20px' : '8px 18px', whiteSpace: 'nowrap',
  }}>{label}</span>;
}

export function PromiseDiagram({ stage, portrait }: { stage: 'pending' | 'fulfilled' | 'rejected' | 'recovered'; portrait: boolean }) {
  const note = stage === 'recovered'
    ? 'La original permanece rechazada. En este ejemplo, catch devuelve una NUEVA promesa fulfilled.'
    : 'La promesa se establece una sola vez: pending → fulfilled o rejected.';
  return <DiagramPanel title="Ciclo de vida de una promesa">
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: portrait ? 16 : 14, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PromisePill label="pending" active={stage === 'pending'} tone="idle" portrait={portrait} />
        <span style={ARROW_STYLE}>→ resolve →</span>
        <PromisePill label="fulfilled" active={stage === 'fulfilled'} tone="ok" portrait={portrait} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ width: portrait ? 78 : 70, flexShrink: 0 }} />
        <span style={ARROW_STYLE}>→ reject →</span>
        <PromisePill label="rejected" active={stage === 'rejected' || stage === 'recovered'} tone="bad" portrait={portrait} />
        <span style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 15 : 14, color: tutorialTheme.quietText }}>
          (estado final)
        </span>
      </div>
      {stage === 'recovered' ? <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        borderTop: '1px dashed #31483F', paddingTop: portrait ? 16 : 14,
      }}>
        <span style={ARROW_STYLE}>catch →</span>
        <PromisePill label="nueva promesa · fulfilled" active tone="ok" portrait={portrait} />
      </div> : null}
      <div style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 17 : 15, color: tutorialTheme.quietText, lineHeight: 1.4 }}>
        {note}
      </div>
    </div>
  </DiagramPanel>;
}

function TimelineBar({ label, valueMs, maxMs, tone, portrait }: {
  label: string; valueMs: number; maxMs: number; tone: 'seq' | 'concurrent'; portrait: boolean;
}) {
  const percent = maxMs > 0 ? Math.max(6, Math.min(100, (valueMs / maxMs) * 100)) : 0;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: tutorialTheme.mono,
      fontSize: portrait ? 17 : 15, color: tutorialTheme.quietText }}>
      <span>{label}</span>
      <span style={{ color: tone === 'concurrent' ? LIME : tutorialTheme.lightText }}>≈ {(valueMs / 1000).toFixed(1)} s</span>
    </div>
    <div style={{ height: portrait ? 26 : 22, borderRadius: 6, background: '#0F1C19', overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${percent}%`, borderRadius: 6,
        background: tone === 'concurrent' ? LIME : '#7FA08E',
      }} />
    </div>
  </div>;
}

export function TimelineDiagram({ variant, measurements, portrait }: {
  variant: 'conceptual' | 'measured';
  measurements: { sequentialMs: number; concurrentMs: number } | null;
  portrait: boolean;
}) {
  if (variant === 'measured' && measurements) {
    const maxMs = Math.max(measurements.sequentialMs, measurements.concurrentMs);
    return <DiagramPanel title="Timeline medida · Node">
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: portrait ? 20 : 18, width: '100%' }}>
        <TimelineBar label="Secuencial: await, luego await" valueMs={measurements.sequentialMs} maxMs={maxMs} tone="seq" portrait={portrait} />
        <TimelineBar label="Concurrente: Promise.all" valueMs={measurements.concurrentMs} maxMs={maxMs} tone="concurrent" portrait={portrait} />
        <div style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 15 : 14, color: tutorialTheme.quietText }}>
          Medición aproximada, no garantía de tiempo real.
        </div>
      </div>
    </DiagramPanel>;
  }
  return <DiagramPanel title="Esperar sin detener todo">
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: portrait ? 18 : 16, width: '100%' }}>
      <div style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 17 : 15, color: tutorialTheme.quietText }}>
        Operación lenta: red · archivo · usuario
      </div>
      <div style={{ height: portrait ? 30 : 26, borderRadius: 6, background: '#0F1C19', overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: '55%', height: '100%', background: '#7FA08E', display: 'flex', alignItems: 'center', paddingLeft: 12,
          fontFamily: tutorialTheme.mono, fontSize: portrait ? 15 : 14, color: tutorialTheme.dark }}>espera</div>
        <div style={{ flex: 1, height: '100%', borderLeft: `2px dashed ${LIME}`, display: 'flex', alignItems: 'center', paddingLeft: 12,
          fontFamily: tutorialTheme.mono, fontSize: portrait ? 15 : 14, color: LIME }}>otras tareas siguen</div>
      </div>
      <div style={{ fontFamily: tutorialTheme.mono, fontSize: portrait ? 16 : 15, color: tutorialTheme.quietText, lineHeight: 1.4 }}>
        La asincronía organiza la espera; no elimina su coste.
      </div>
    </div>
  </DiagramPanel>;
}
