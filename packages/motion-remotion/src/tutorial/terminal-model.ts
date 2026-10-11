export type TerminalEntry = {
  text: string;
  /** Frame relative to the enclosing Remotion Sequence. */
  at: number;
  /** Typing duration in frames; omitted means immediate output. */
  duration?: number;
  kind: 'command' | 'output' | 'success' | 'comment';
};

export type TerminalRow = {
  text: string;
  kind: TerminalEntry['kind'];
  prompt: boolean;
  active: boolean;
};

/** Pure frame sampling: scrubbing backwards gives exactly the same output. */
export function terminalRows(
  entries: readonly TerminalEntry[],
  frame: number,
  maxRows = 12,
): TerminalRow[] {
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error('maxRows must be a positive integer');
  }
  const visible = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => frame >= entry.at)
    .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index);
  const last = visible.length - 1;
  const rows = visible.flatMap(({ entry }, index): TerminalRow[] => {
    const duration = Math.max(0, entry.duration ?? 0);
    const progress = duration === 0 ? 1 : Math.min(1, (frame - entry.at) / duration);
    const characters = Array.from(entry.text);
    const text = characters.slice(0, Math.floor(characters.length * progress)).join('');
    const lines = text.split('\n');
    return lines.map((line, lineIndex) => ({
      text: line,
      kind: entry.kind,
      prompt: entry.kind === 'command' && lineIndex === 0,
      active: index === last && lineIndex === lines.length - 1 && entry.kind === 'command',
    }));
  });
  return rows.slice(-maxRows);
}
