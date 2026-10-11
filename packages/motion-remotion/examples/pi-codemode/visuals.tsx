/**
 * visuals.tsx — Presentación del ejemplo `pi-codemode` (tema oscuro enérgico).
 *
 * Aporta el marco editorial por escena (kicker, capítulo, progreso, idea clave,
 * captions anclados a palabras reales y pie honesto) y un diagrama GRANDE por
 * escena: una sola idea por cuadro, sin diapositivas estáticas. Todas las
 * operaciones se etiquetan como ilustrativas (no una sesión real de Pi).
 * Sólo CSS/SVG inline y fuentes de sistema: ningún asset externo.
 */
import React, { type CSSProperties, type ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CodeLine, CodeToken, SubtitleWord } from '../../src';
import { captionCues, cumulativeLines, normalizeWord } from './helpers';
import { SAFE, theme } from './theme';

const CODE_COLORS: Record<NonNullable<CodeToken['kind']>, string> = {
  plain: theme.text,
  keyword: '#C9A7FF',
  string: theme.lime,
  number: '#FFC978',
  comment: theme.dim,
  function: theme.cyan,
  type: '#FFC978',
};

/** Entrada rápida: opacidad + desplazamiento corto, sin rebote ni sacudida. */
function Enter({ delay = 0, dy = 18, style, children }: {
  delay?: number; dy?: number; style?: CSSProperties; children: ReactNode;
}) {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [delay, delay + 9], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return <div style={{ opacity: progress, transform: `translateY(${(1 - progress) * dy}px)`, ...style }}>{children}</div>;
}

/**
 * Línea de flujo animada (guiones en movimiento) en CSS, sin SVG ni red.
 * `orientation` elige el eje; el color y el grosor son parámetros.
 */
function FlowLine({ color = theme.cyan, orientation = 'vertical', active = true, thickness = 6, style }: {
  color?: string; orientation?: 'vertical' | 'horizontal'; active?: boolean; thickness?: number; style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const dash = 11;
  const gap = 13;
  const period = dash + gap;
  const offset = (frame * 2.6) % period;
  const vertical = orientation === 'vertical';
  const gradient = vertical
    ? `repeating-linear-gradient(to bottom, ${color} 0 ${dash}px, transparent ${dash}px ${period}px)`
    : `repeating-linear-gradient(to right, ${color} 0 ${dash}px, transparent ${dash}px ${period}px)`;
  return <div style={{
    borderRadius: thickness / 2,
    backgroundImage: gradient,
    backgroundPosition: vertical ? `0 ${offset}px` : `${offset}px 0`,
    opacity: active ? 1 : 0.28,
    ...(vertical ? { width: thickness, height: '100%' } : { height: thickness, width: '100%' }),
    ...style,
  }} />;
}

/** Pelota/paquete que rebota dentro de su contenedor (posicionado en %). */
function BouncingBall({ axis, color = theme.lime, period = 20, size = 26, opacity = 1 }: {
  axis: 'x' | 'y'; color?: string; period?: number; size?: number; opacity?: number;
}) {
  const frame = useCurrentFrame();
  const travel = Math.abs(Math.sin((frame / period) * Math.PI));
  const percent = 6 + travel * 88;
  const position: CSSProperties = axis === 'y'
    ? { top: `${percent}%`, left: '50%', transform: 'translate(-50%, -50%)' }
    : { left: `${percent}%`, top: '50%', transform: 'translate(-50%, -50%)' };
  return <span style={{
    position: 'absolute', width: size, height: size, borderRadius: '50%', opacity,
    background: color, boxShadow: `0 0 ${size}px ${color}AA`, ...position,
  }} />;
}

/** Tarjeta oscura con cabecera (panel base de todo el ejemplo). */
function Panel({ title, accent = theme.cyan, children, style, bodyStyle }: {
  title: string; accent?: string; children: ReactNode; style?: CSSProperties; bodyStyle?: CSSProperties;
}) {
  return <div style={{
    display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden',
    background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 18, ...style,
  }}>
    <div style={{
      minHeight: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px',
      background: theme.panelRaised, borderBottom: `1px solid ${theme.border}`,
    }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: accent, flexShrink: 0 }} />
      <span style={{ fontFamily: theme.mono, fontSize: 32, letterSpacing: 1, lineHeight: 1.25, color: theme.muted, overflowWrap: 'anywhere' }}>{title}</span>
    </div>
    <div style={{ flex: 1, minHeight: 0, padding: 18, display: 'flex', flexDirection: 'column', ...bodyStyle }}>{children}</div>
  </div>;
}

function Chip({ label, active = false, tone = 'cyan', dashed = false, fontSize = 38 }: {
  label: string; active?: boolean; tone?: 'cyan' | 'lime' | 'amber' | 'dim'; dashed?: boolean; fontSize?: number;
}) {
  const color = tone === 'lime' ? theme.lime : tone === 'amber' ? theme.amber : tone === 'dim' ? theme.muted : theme.cyan;
  return <span style={{
    fontFamily: theme.mono, fontSize, letterSpacing: 0.5, whiteSpace: 'nowrap',
    color: active ? color : theme.muted,
    background: active ? `${color}1A` : theme.panelRaised,
    border: `${dashed ? 2 : 1.5}px ${dashed ? 'dashed' : 'solid'} ${active ? color : theme.border}`,
    borderRadius: 999, padding: '12px 22px', opacity: active ? 1 : 0.7,
  }}>{label}</span>;
}

function Node({ label, note, tone = 'cyan', active = true, optional = false }: {
  label: string; note?: string; tone?: 'cyan' | 'lime' | 'amber'; active?: boolean; optional?: boolean;
}) {
  const color = tone === 'lime' ? theme.lime : tone === 'amber' ? theme.amber : theme.cyan;
  return <div style={{
    borderRadius: 16, padding: '18px 24px', minWidth: 0,
    background: active ? `${color}14` : theme.panel,
    border: `2px ${optional ? 'dashed' : 'solid'} ${active ? color : theme.border}`,
    display: 'flex', flexDirection: 'column', gap: 6,
  }}>
    <span style={{ fontFamily: theme.mono, fontSize: 42, fontWeight: 700, color: active ? color : theme.text }}>{label}</span>
    {note ? <span style={{ fontSize: 34, color: theme.muted, lineHeight: 1.25 }}>{note}</span> : null}
  </div>;
}

/** Panel de código oscuro, máximo 6 líneas, 42–46 px. */
export function CodeCard({ lines, highlightLines = [], label, fontSize = 44, maxLines = 6 }: {
  lines: readonly CodeLine[]; highlightLines?: readonly number[]; label: string; fontSize?: number; maxLines?: number;
}) {
  const shown = lines.slice(0, maxLines);
  return <Panel title={label} accent={theme.cyan} bodyStyle={{ padding: '16px 0' }} style={{ minHeight: 0, flexShrink: 0 }}>
    <div style={{ fontFamily: theme.mono, fontSize, lineHeight: 1.5 }}>
      {shown.map((line, index) => {
        const number = index + 1;
        const highlighted = highlightLines.includes(number);
        return <div key={number} style={{
          display: 'flex', padding: '0 22px 0 16px',
          borderLeft: `6px solid ${highlighted ? theme.lime : 'transparent'}`,
          background: highlighted ? `${theme.lime}12` : 'transparent',
        }}>
          <span style={{ width: 52, flexShrink: 0, textAlign: 'right', marginRight: 16, color: highlighted ? theme.lime : theme.dim }}>{number}</span>
          <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}>
            {line.tokens.length === 0
              ? '\u00a0'
              : line.tokens.map((token, tokenIndex) => (
                <span key={tokenIndex} style={{ color: CODE_COLORS[token.kind ?? 'plain'] }}>{token.text}</span>
              ))}
          </span>
        </div>;
      })}
    </div>
  </Panel>;
}

function TakeawayStrip({ text, accent }: { text: string; accent: string }) {
  return <div style={{
    marginTop: 16, display: 'flex', alignItems: 'center', gap: 18,
    borderLeft: `6px solid ${accent}`, background: theme.panel, borderRadius: 14, padding: '14px 22px',
  }}>
    <span style={{ fontFamily: theme.mono, fontSize: 32, letterSpacing: 2, color: accent, whiteSpace: 'nowrap' }}>IDEA CLAVE</span>
    <span style={{ fontSize: 42, fontWeight: 700, color: theme.text, lineHeight: 1.2 }}>{text}</span>
  </div>;
}

/** Captions anclados a palabras reales, 2 líneas máximo, altura fija. */
function CaptionTrack({ words, seconds, emphasisTokens }: {
  words: readonly SubtitleWord[]; seconds: number; emphasisTokens: Record<string, true>;
}) {
  const cues = captionCues(words);
  const active = cues.find((cue) => seconds >= cue.start && seconds <= cue.end) ?? null;
  return <div style={{
    height: 124, marginTop: 14, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
    alignContent: 'center', columnGap: 16, rowGap: 4, overflow: 'hidden', textAlign: 'center',
  }}>
    {active ? active.words.map((word, index) => {
      const spoken = seconds >= word.start;
      const current = spoken && seconds <= word.end + 0.12;
      const emphasized = emphasisTokens[normalizeWord(word.word)] === true;
      const color = current ? theme.cyan : spoken ? (emphasized ? theme.lime : theme.text) : theme.muted;
      return <span key={`${word.start}:${index}`} style={{
        fontSize: 46, fontWeight: 800, lineHeight: 1.15, color,
        textShadow: '0 2px 10px rgba(0,0,0,0.65)',
      }}>{word.word}</span>;
    }) : null}
  </div>;
}

export interface SceneFrameProps {
  scene: { id: string; kind: string; kicker: string; title: string; takeaway: string };
  index: number;
  total: number;
  startFrame: number;
  totalFrames: number;
  captionWords: readonly SubtitleWord[];
  emphasisTokens: Record<string, true>;
  hideTitle?: boolean;
  hideTakeaway?: boolean;
  accent: string;
  children: ReactNode;
}

function titleSize(title: string): number {
  if (title.length <= 22) return 92;
  if (title.length <= 36) return 82;
  return 72;
}

export function SceneFrame({
  scene, index, total, startFrame, totalFrames, captionWords, emphasisTokens, hideTitle, hideTakeaway, accent, children,
}: SceneFrameProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const portrait = height > width;
  const seconds = frame / fps;
  const overall = Math.min(1, (startFrame + frame) / Math.max(1, totalFrames));
  const chapter = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;

  return <AbsoluteFill style={{
    background: theme.bg, color: theme.text, fontFamily: theme.sans,
    padding: portrait ? `${SAFE.top}px ${SAFE.side}px ${SAFE.bottom}px` : '64px 96px 120px',
    display: 'flex', flexDirection: 'column',
  }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 18, flexShrink: 0 }}>
      <Enter delay={0} dy={10}><span style={{ fontSize: 34, fontWeight: 800, letterSpacing: 4, color: accent }}>{scene.kicker}</span></Enter>
      <span style={{ fontFamily: theme.mono, fontSize: 30, color: theme.dim, letterSpacing: 1 }}>{chapter}</span>
    </div>

    {hideTitle ? null : <Enter delay={2} dy={14} style={{ marginTop: 14, flexShrink: 0 }}>
      <h1 style={{
        fontSize: titleSize(scene.title), fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.05,
        margin: 0, color: theme.text, overflowWrap: 'break-word',
      }}>{scene.title}</h1>
    </Enter>}

    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', marginTop: 20, gap: 14 }}>
      {children}
    </div>

    {hideTakeaway ? null : <Enter delay={12} dy={10} style={{ flexShrink: 0 }}>
      <TakeawayStrip text={scene.takeaway} accent={accent} />
    </Enter>}

    <CaptionTrack words={captionWords} seconds={seconds} emphasisTokens={emphasisTokens} />

    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
      marginTop: 8, flexShrink: 0, borderTop: `1px solid ${theme.border}`, paddingTop: 12,
    }}>
      <span style={{ fontSize: 32, color: theme.muted, letterSpacing: 1 }}>ESQUEMA ILUSTRATIVO</span>
      <span style={{ fontFamily: theme.mono, fontSize: 32, color: theme.muted, letterSpacing: 1 }}>Pi · Code Mode</span>
    </div>

    <div style={{ position: 'absolute', left: SAFE.side, right: SAFE.side, bottom: 44, height: 6, borderRadius: 3, background: theme.border }}>
      <div style={{ height: '100%', width: `${overall * 100}%`, borderRadius: 3, background: theme.cyan }} />
      <div style={{ position: 'absolute', top: -4, left: `calc(${overall * 100}% - 7px)`, width: 14, height: 14, borderRadius: '50%', background: theme.lime }} />
    </div>
  </AbsoluteFill>;
}

/* ------------------------------------------------------------------ */
/* Diagramas por tipo de escena                                        */
/* ------------------------------------------------------------------ */

/** Hook: enunciado enorme + pelota rebotando entre MODELO y TOOL. */
export function HookVisual({ stage }: { stage: number }) {
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
      <Enter delay={2}><span style={{ fontSize: 116, fontWeight: 800, letterSpacing: -3, lineHeight: 1.0, color: theme.cyan }}>¿PIENSA?</span></Enter>
      <Enter delay={9}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 92, fontWeight: 800, letterSpacing: -2, lineHeight: 1.02, color: theme.text }}>¿O HACE</span>
          <span style={{ fontSize: 92, fontWeight: 800, letterSpacing: -2, lineHeight: 1.02, color: stage >= 1 ? theme.lime : theme.text }}>PING-PONG?</span>
        </div>
      </Enter>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
      <Node label="MODELO" note="decide el siguiente paso" tone="cyan" active={stage >= 0} />
      <div style={{ position: 'absolute', top: '18%', bottom: '18%', left: '50%', transform: 'translateX(-50%)' }}>
        <FlowLine color={theme.cyan} />
      </div>
      <BouncingBall axis="y" color={theme.lime} period={17} size={28} />
      <BouncingBall axis="y" color={theme.cyan} period={17} size={16} opacity={0.5} />
      <Node label="TOOL" note="una llamada por vez" tone="lime" active={stage >= 1} />
    </div>
  </div>;
}

/** Ping-pong: ida y vuelta con contador de pasos ilustrativo. */
export function PingPongVisual({ stage }: { stage: number }) {
  const steps = ['BUSCAR', 'VOLVER', 'LEER', 'VOLVER'];
  const current = Math.max(0, Math.min(steps.length - 1, stage));
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 22 }}>
    <Panel title="ida y vuelta" accent={theme.cyan} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <Node label="MODELO" tone="cyan" />
        <div style={{ flex: 1, position: 'relative', height: 84, display: 'flex', alignItems: 'center' }}>
          <FlowLine color={theme.lime} orientation="horizontal" />
          <BouncingBall axis="x" color={theme.lime} period={16} size={26} />
        </div>
        <Node label="TOOL" tone="lime" />
      </div>
    </Panel>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center' }}>
      {steps.map((label, index) => (
        <div key={`${label}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: theme.mono, fontSize: 32, color: theme.dim }}>{index + 1}</span>
          <Chip label={label} active={stage >= index} tone={index % 2 === 0 ? 'cyan' : 'lime'} fontSize={38} />
        </div>
      ))}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, flexWrap: 'wrap' }}>
      <Chip label={`PASO ${current + 1} / ${steps.length}`} active tone="amber" fontSize={36} />
      <span style={{ fontSize: 34, color: theme.muted }}>contador ilustrativo, sin métricas de velocidad</span>
    </div>
    <div style={{ marginTop: 'auto', fontSize: 38, color: theme.text, lineHeight: 1.3 }}>
      Puede llenar el contexto y sumar latencia, <span style={{ color: theme.cyan, fontWeight: 700 }}>sin una decisión nueva</span>.
    </div>
  </div>;
}

/** Orchestrate: modelo escribe un script que llama varias herramientas. */
export function OrchestrateVisual({ stage }: { stage: number }) {
  const scriptLines = [
    'const result = await Promise.all(',
    '  paths.map((path) =>',
    '    tools.read({ path })),',
    ');',
    'text(result.length);',
  ];
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Node label="MODELO" note="diseña el recorrido" tone="cyan" active={stage >= 0} />
    <div style={{ height: 24, display: 'flex', justifyContent: 'center' }}>
      <FlowLine color={theme.cyan} active={stage >= 0} />
    </div>
    <Panel title="SCRIPT · ejemplo ilustrativo" accent={theme.lime} style={{ flexShrink: 0 }}>
      <div style={{ fontFamily: theme.mono, fontSize: 42, lineHeight: 1.45 }}>
        {scriptLines.map((line, index) => (
          <div key={index} style={{ color: stage >= 0 ? theme.text : theme.dim }}>{line}</div>
        ))}
      </div>
    </Panel>
    <div style={{ height: 24, display: 'flex', justifyContent: 'center' }}>
      <FlowLine color={theme.lime} active={stage >= 1} />
    </div>
    <Panel title="HERRAMIENTAS DEL HOST · ejemplo" accent={theme.lime} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {['read', 'bash', 'grep', 'list'].map((tool) => (
          <Chip key={tool} label={tool} active={stage >= 1} tone="lime" fontSize={36} />
        ))}
      </div>
    </Panel>
    <div style={{ height: 24, display: 'flex', justifyContent: 'center' }}>
      <FlowLine color={theme.amber} active={stage >= 2} />
    </div>
    <Node label="MODELO" note="recibe una salida acotada" tone="amber" active={stage >= 2} />
  </div>;
}

const CODE_STEPS: readonly (readonly number[])[] = [[1, 2], [3, 4, 5], [6]];

/** Código: panel de 6 líneas + flujo BUSCAR → FILTRAR → DEVOLVER. */
export function CodeVisual({ lines, stage, label }: { lines: readonly CodeLine[]; stage: number; label: string }) {
  const flow = ['BUSCAR', 'FILTRAR', 'DEVOLVER'];
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <CodeCard lines={lines} label={label} highlightLines={cumulativeLines(CODE_STEPS, stage)} fontSize={44} />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
      {flow.map((step, index) => (
        <React.Fragment key={step}>
          {index > 0 ? <span style={{ fontSize: 40, color: theme.dim }}>→</span> : null}
          <Chip label={step} active={stage >= index} tone="cyan" fontSize={38} />
        </React.Fragment>
      ))}
    </div>
    <div style={{ fontSize: 32, color: theme.muted, lineHeight: 1.3 }}>
      Consultas independientes, <span style={{ color: theme.lime }}>en paralelo</span>. Menos ida y vuelta; no velocidad mágica.
    </div>
  </div>;
}

/** Discovery: catálogo → candidatas (BM25) → contrato. */
export function DiscoveryVisual({ stage, lines, label }: { stage: number; lines: readonly CodeLine[]; label: string }) {
  const catalog = ['herramienta 1', 'herramienta 2', 'herramienta 3', 'herramienta 4'];
  const codeLines = stage >= 2 ? [1, 2, 3, 4] : stage >= 1 ? [1, 2, 3] : [];
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
    <Panel title="CATÁLOGO · ejemplo" accent={theme.muted} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {catalog.map((tool) => <Chip key={tool} label={tool} active={stage >= 0} tone="dim" fontSize={32} />)}
      </div>
    </Panel>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexShrink: 0 }}>
      <FlowLine color={theme.cyan} orientation="horizontal" active={stage >= 1} style={{ width: '30%' }} />
      <span style={{ fontFamily: theme.mono, fontSize: 32, color: theme.cyan }}>searchTools · BM25</span>
      <FlowLine color={theme.cyan} orientation="horizontal" active={stage >= 1} style={{ width: '30%' }} />
    </div>
    <Panel title="CANDIDATAS" accent={theme.cyan} style={{ flexShrink: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {['candidata A', 'candidata B', 'candidata C'].map((tool) => (
          <Chip key={tool} label={tool} active={stage >= 1} tone="cyan" fontSize={34} />
        ))}
      </div>
    </Panel>
    <CodeCard lines={lines} label={label} highlightLines={codeLines} fontSize={42} maxLines={4} />
    <div style={{ fontSize: 32, color: theme.muted, lineHeight: 1.3, flexShrink: 0 }}>
      BM25 ordena el catálogo; <span style={{ color: theme.amber }}>no busca símbolos dentro de archivos</span>.
    </div>
  </div>;
}

/** Classifier: Jev es OPCIONAL, ayuda a decidir; no concede permisos. */
export function ClassifierVisual({ stage }: { stage: number }) {
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <Chip label="OPCIONAL · NO OBLIGATORIO" dashed active tone="amber" fontSize={36} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 14 }}>
        <Node label="ESTADO" note="qué está pasando" tone="cyan" active={stage >= 0} />
        <Node label="CRITERIOS" note="reglas que tú defines" tone="cyan" active={stage >= 1} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', height: 40 }}>
        <FlowLine color={theme.amber} active={stage >= 1} />
      </div>
      <Node label="JEV · clasificador" note="elige entre opciones o evalúa evidencia" tone="amber" active={stage >= 1} optional />
      <div style={{ display: 'flex', justifyContent: 'center', height: 40 }}>
        <FlowLine color={theme.lime} active={stage >= 2} />
      </div>
      <Node label="DECISIÓN ESTRUCTURADA" note="una elección acotada, no una acción" tone="lime" active={stage >= 2} />
    </div>
    <div style={{ marginTop: 'auto', fontSize: 36, color: theme.muted, lineHeight: 1.3 }}>
      Ayuda a decidir; <span style={{ color: theme.text }}>no reemplaza al modelo principal</span> ni es obligatorio en Code Mode.
    </div>
  </div>;
}

/** Guard: clasificar NO es autorizar (ámbar). */
export function GuardVisual({ stage }: { stage: number }) {
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 16 }}>
      <Node label="CLASIFICACIÓN" note="«esta acción parece segura»" tone="amber" active={stage >= 0} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 90 }}>
        <span style={{ fontSize: 96, fontWeight: 800, color: theme.amber, lineHeight: 1 }}>≠</span>
      </div>
      <Node label="PERMISOS" note="quién puede ejecutar" tone="cyan" active={stage >= 1} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Node label="VALIDACIÓN" note="las reglas siguen mandando" tone="cyan" active={stage >= 2} />
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Chip label="las llamadas son reales" active tone="amber" fontSize={36} />
        <Chip label="si el script falla…" active tone="amber" fontSize={36} />
      </div>
      <div style={{ fontSize: 40, fontWeight: 700, color: theme.text, lineHeight: 1.3 }}>
        …lo que ya ejecutó <span style={{ color: theme.amber }}>no se deshace</span>.
      </div>
    </div>
    <div style={{ marginTop: 'auto', fontSize: 36, color: theme.muted, lineHeight: 1.3 }}>
      Clasificar como segura <span style={{ color: theme.amber, fontWeight: 700 }}>no autoriza</span> ejecutar.
    </div>
  </div>;
}

/** Roles: cada pieza, su trabajo. Pi coordina; Code Mode organiza; MCP conecta; Jev evalúa. */
export function RolesVisual({ stage }: { stage: number }) {
  const roles = [
    { label: 'PI', verb: 'coordina el recorrido', tone: 'cyan' as const, optional: false },
    { label: 'CODE MODE', verb: 'organiza la ejecución', tone: 'lime' as const, optional: false },
    { label: 'MCP', verb: 'conecta herramientas', tone: 'cyan' as const, optional: false },
    { label: 'JEV', verb: 'puede evaluar (opcional)', tone: 'amber' as const, optional: true },
  ];
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
    {roles.map((role, index) => {
      const active = stage >= index;
      const color = role.tone === 'lime' ? theme.lime : role.tone === 'amber' ? theme.amber : theme.cyan;
      return <Enter key={role.label} delay={index * 3} style={{ flex: 1, minHeight: 0 }}>
        <div style={{
          height: '100%', display: 'flex', alignItems: 'center', gap: 22, borderRadius: 16, padding: '0 26px',
          background: active ? `${color}14` : theme.panel,
          border: `2px ${role.optional ? 'dashed' : 'solid'} ${active ? color : theme.border}`,
        }}>
          <span style={{ fontFamily: theme.mono, fontSize: 52, fontWeight: 800, color: active ? color : theme.muted, minWidth: 300 }}>{role.label}</span>
          <span style={{ fontSize: 42, color: active ? theme.text : theme.muted, lineHeight: 1.2 }}>{role.verb}</span>
        </div>
      </Enter>;
    })}
    <div style={{ fontSize: 34, color: theme.muted, lineHeight: 1.3 }}>
      Separar responsabilidades <span style={{ color: theme.text }}>puede reducir</span> ruido y contexto innecesario.
    </div>
  </div>;
}

/** Cierre: CTA grande, sin prometer magia. */
export function CtaVisual({ stage }: { stage: number }) {
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18 }}>
    <Enter delay={2}>
      <span style={{ display: 'block', fontSize: 112, fontWeight: 800, letterSpacing: -3, lineHeight: 1.0, color: stage >= 0 ? theme.cyan : theme.text }}>MENOS</span>
    </Enter>
    <Enter delay={6}>
      <span style={{ display: 'block', fontSize: 112, fontWeight: 800, letterSpacing: -3, lineHeight: 1.0, color: stage >= 0 ? theme.cyan : theme.text }}>PING-PONG.</span>
    </Enter>
    <Enter delay={12}>
      <span style={{ display: 'block', fontSize: 96, fontWeight: 800, letterSpacing: -3, lineHeight: 1.05, color: stage >= 1 ? theme.lime : theme.text }}>MÁS TRABAJO ÚTIL.</span>
    </Enter>
    <Enter delay={20}>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Chip label="TAREA PEQUEÑA · SOLO LECTURA" active tone="lime" fontSize={32} />
        <span style={{ fontSize: 34, color: theme.muted }}>Guarda este esquema y pruébalo en pequeño.</span>
      </div>
    </Enter>
  </div>;
}
