import React, { type CSSProperties, type ReactNode } from 'react';
import { AbsoluteFill, interpolate, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';

export const tutorialTheme = {
  paper: '#F2F0E9',
  ink: '#162D29',
  muted: '#5E7068',
  accent: '#116B50',
  lime: '#D6EF96',
  dark: '#142622',
  darkRaised: '#1C332D',
  lightText: '#EEF3E8',
  quietText: '#A4B9AF',
  border: '#D0D8C9',
  mono: '"DejaVu Sans Mono", "Liberation Mono", monospace',
  sans: '"DejaVu Sans", Arial, sans-serif',
} as const;

export function DesktopWindow({
  title,
  badge,
  children,
  style,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{
      height: '100%', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      borderRadius: 20, background: tutorialTheme.dark, color: tutorialTheme.lightText,
      border: '1px solid #31483F', boxShadow: '0 24px 64px #162D291A', ...style,
    }}>
      <div style={{ height: 62, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 26px', borderBottom: '1px solid #31483F', background: tutorialTheme.darkRaised }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {['#B67D69', '#C2B57C', '#8DAC8E'].map((color) => (
            <span key={color} style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
          ))}
        </div>
        <span style={{ marginLeft: 14, fontFamily: tutorialTheme.mono, fontSize: 20,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        {badge && <span style={{ marginLeft: 'auto', color: tutorialTheme.quietText,
          fontSize: 16, whiteSpace: 'nowrap', letterSpacing: 1 }}>{badge}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

/** Orientation-aware canvas; scenes still own the arrangement of their child panels. */
export function TutorialLayout({
  eyebrow,
  title,
  description,
  step,
  children,
  aside,
  series = 'BUILD NOTES',
  topic = 'OPENCODE',
  footer = 'DEMO ILUSTRATIVA · NO ES UNA SESIÓN REAL DE OPENCODE',
}: {
  eyebrow: string;
  title: string;
  description?: string;
  step: string;
  children: ReactNode;
  aside?: ReactNode;
  series?: string;
  topic?: string;
  footer?: string;
}) {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const portrait = height > width;
  const enter = interpolate(frame, [0, 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: tutorialTheme.paper, color: tutorialTheme.ink,
      fontFamily: tutorialTheme.sans, padding: portrait ? '80px 64px 96px' : '54px 76px 38px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 24, borderBottom: `1px solid ${tutorialTheme.border}` }}>
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: 3 }}>{series} <span style={{ color: tutorialTheme.accent }}>/ {topic}</span></span>
        <span style={{ fontFamily: tutorialTheme.mono, fontSize: 20, color: tutorialTheme.muted }}>{step}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingTop: 36,
        opacity: enter, transform: `translateY(${(1 - enter) * 16}px)` }}>
        <div style={{ color: tutorialTheme.accent, fontSize: 18, fontWeight: 700, letterSpacing: 3 }}>{eyebrow}</div>
        <h1 style={{ fontSize: portrait ? 70 : 66, fontWeight: 700, letterSpacing: -3, lineHeight: 1.1, margin: '16px 0' }}>{title}</h1>
        {description && <div style={{ fontSize: portrait ? 30 : 26, color: tutorialTheme.muted, lineHeight: 1.5 }}>{description}</div>}
        <div style={{ display: 'flex', flexDirection: portrait ? 'column' : 'row', gap: portrait ? 24 : 38,
          flex: 1, minHeight: 0, marginTop: 32, marginBottom: 30 }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{children}</div>
          {aside && <div style={{ width: portrait ? '100%' : 370, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>{aside}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: portrait ? 'column' : 'row', gap: 12,
        justifyContent: 'space-between', borderTop: `1px solid ${tutorialTheme.border}`,
        paddingTop: 22, fontSize: portrait ? 17 : 15, letterSpacing: 1.5, color: tutorialTheme.muted }}>
        <span>{footer}</span><span>{width} × {height} / {fps} FPS</span>
      </div>
    </AbsoluteFill>
  );
}

export function Callout({ number, title, children, from = 0 }: {
  number: string;
  title: string;
  children: ReactNode;
  from?: number;
}) {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [from, from + 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <div style={{ opacity: progress, transform: `translateX(${(1 - progress) * 16}px)`,
    padding: '28px 0 28px 28px', borderLeft: `3px solid ${tutorialTheme.accent}` }}>
    <div style={{ fontFamily: tutorialTheme.mono, color: tutorialTheme.accent, fontSize: 20, marginBottom: 22 }}>{number} /</div>
    <div style={{ fontSize: 31, fontWeight: 700, lineHeight: 1.2, marginBottom: 18 }}>{title}</div>
    <div style={{ fontSize: 24, lineHeight: 1.55, color: tutorialTheme.muted }}>{children}</div>
  </div>;
}

/** Decorative pointer for authored explanations, not a claim of captured user input. */
export function TutorialPointer({ x, y, label }: { x: number; y: number; label?: string }) {
  return <div style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, display: 'flex', alignItems: 'center', gap: 12, pointerEvents: 'none' }}>
    <svg width="32" height="40" viewBox="0 0 32 40" aria-hidden="true">
      <path d="M3 2 L27 25 L16 26 L11 37 Z" fill={tutorialTheme.lime} stroke={tutorialTheme.dark} strokeWidth="2" />
    </svg>
    {label && <span style={{ background: tutorialTheme.lime, color: tutorialTheme.ink,
      borderRadius: 8, padding: '10px 16px', fontSize: 20, fontFamily: tutorialTheme.sans }}>{label}</span>}
  </div>;
}

export function ScreenRecording({
  src, title = 'Grabación de pantalla', badge = 'VIDEO', startFrom = 0, endAt,
  muted = true, zoom = 1, focus = { x: 50, y: 50 }, overlay,
}: {
  src: string;
  title?: string;
  badge?: string;
  /** Source trim positions in frames at the composition fps. */
  startFrom?: number;
  endAt?: number;
  muted?: boolean;
  zoom?: number;
  focus?: { x: number; y: number };
  overlay?: ReactNode;
}) {
  return <DesktopWindow title={title} badge={badge}>
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <OffthreadVideo src={src} startFrom={startFrom} endAt={endAt} muted={muted}
        style={{ width: '100%', height: '100%', objectFit: 'contain',
          transform: `scale(${Math.max(1, zoom)})`, transformOrigin: `${focus.x}% ${focus.y}%` }} />
      {overlay}
    </AbsoluteFill>
  </DesktopWindow>;
}
