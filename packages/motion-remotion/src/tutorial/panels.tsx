import React from 'react';
import { useCurrentFrame } from 'remotion';
import { DesktopWindow, tutorialTheme } from './primitives';
import { terminalRows, type TerminalEntry } from './terminal-model';

export function TerminalWindow({
  entries, title = '~/project', prompt = '❯', fontSize = 30, maxRows = 11,
}: {
  entries: readonly TerminalEntry[];
  title?: string;
  prompt?: string;
  fontSize?: number;
  maxRows?: number;
}) {
  const frame = useCurrentFrame();
  const rows = terminalRows(entries, frame, maxRows);
  return <DesktopWindow title={title} badge="TERMINAL">
    <div style={{ padding: 30, fontFamily: tutorialTheme.mono, fontSize, lineHeight: 1.65 }}>
      {rows.map((row, index) => <div key={index} style={{ display: 'flex', minHeight: fontSize * 1.65,
        color: row.kind === 'success' ? tutorialTheme.lime : row.kind === 'comment' ? tutorialTheme.quietText : tutorialTheme.lightText }}>
        <span style={{ width: 32, flexShrink: 0, color: tutorialTheme.lime }}>{row.prompt ? prompt : ''}</span>
        <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}>{row.text}{row.active && <span style={{
          display: 'inline-block', width: fontSize * 0.55, height: fontSize * 1.1, verticalAlign: '-0.15em',
          marginLeft: 4, background: tutorialTheme.lime, opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0,
        }} />}</span>
      </div>)}
    </div>
  </DesktopWindow>;
}

/** Pretokenized code keeps rendering deterministic; callers can use any highlighter. */
export type CodeToken = {
  text: string;
  kind?: 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type';
};
export type CodeLine = { tokens: readonly CodeToken[]; change?: 'added' | 'removed' };
const tokenColors: Record<NonNullable<CodeToken['kind']>, string> = {
  plain: tutorialTheme.lightText, keyword: '#C5AFF0', string: '#D6EF96',
  number: '#EBC293', comment: tutorialTheme.quietText, function: '#8CDACC', type: '#EBC293',
};

export function CodePanel({
  filename, lines, highlightLines = [], firstLine = 1, fontSize = 29,
}: {
  filename: string;
  lines: readonly CodeLine[];
  /** One-based displayed line numbers, including firstLine offset. */
  highlightLines?: readonly number[];
  firstLine?: number;
  fontSize?: number;
}) {
  return <DesktopWindow title={filename} badge="CODE">
    <div style={{ padding: '24px 0', fontFamily: tutorialTheme.mono, fontSize, lineHeight: 1.75 }}>
      {lines.map((line, index) => {
        const number = firstLine + index;
        const highlighted = highlightLines.includes(number);
        const color = line.change === 'removed' ? '#F0AC9B' : tutorialTheme.lime;
        return <div key={number} style={{ display: 'flex', padding: '0 24px 0 16px',
          borderLeft: `4px solid ${highlighted ? tutorialTheme.lime : 'transparent'}`,
          background: line.change === 'removed' ? '#613D353F' : highlighted || line.change === 'added' ? '#D6EF9612' : 'transparent' }}>
          <span style={{ width: 48, flexShrink: 0, color: tutorialTheme.quietText, userSelect: 'none', textAlign: 'right', marginRight: 16 }}>{number}</span>
          <span style={{ width: 26, flexShrink: 0, color }}>{line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ''}</span>
          <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}>
            {line.tokens.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: tokenColors[token.kind ?? 'plain'] }}>{token.text}</span>)}
            {line.tokens.length === 0 && '\u00a0'}
          </span>
        </div>;
      })}
    </div>
  </DesktopWindow>;
}
