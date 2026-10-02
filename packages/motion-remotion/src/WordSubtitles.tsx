import React, { useMemo } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

import type { SubtitleWord } from './subtitle-words';
import { buildWordCaptions, clampCaptionYPercent, selectWordCaption } from './word-captions';

export interface WordSubtitlesProps {
  /** Final composition timeline seconds. Mount outside time-shifting Sequences. */
  words: readonly SubtitleWord[];
  /** Vertical center in percent of the canvas. Default: 60. */
  yPercent?: number;
  maxWords?: number;
  maxChars?: number;
  /** Pixels at 1080px composition width; scaled for other output sizes. */
  fontSize?: number;
  fontFamily?: string;
  accentColor?: string;
  textColor?: string;
}

/** Word-timed captions with a central safe width, no background pill or trailing hold. */
export const WordSubtitles: React.FC<WordSubtitlesProps> = ({
  words,
  yPercent = 60,
  maxWords = 4,
  maxChars = 28,
  fontSize = 58,
  fontFamily = 'Arial, Helvetica, sans-serif',
  accentColor = '#67e8f9',
  textColor = '#ffffff',
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const cues = useMemo(() => buildWordCaptions(words, { maxWords, maxChars }), [
    words, maxWords, maxChars,
  ]);
  const selected = selectWordCaption(cues, frame / fps);
  if (!selected) return null;

  const scale = width / 1080;
  const size = (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 58) * scale;

  return (
    <div
      style={{
        position: 'absolute',
        left: '8%',
        width: '84%',
        top: `${clampCaptionYPercent(yPercent)}%`,
        transform: 'translateY(-50%)',
        pointerEvents: 'none',
        fontFamily,
        fontSize: size,
        fontWeight: 800,
        lineHeight: 1.18,
        letterSpacing: -0.5 * scale,
        textAlign: 'center',
        color: textColor,
        WebkitTextStroke: `${2 * scale}px rgba(0, 0, 0, 0.95)`,
        paintOrder: 'stroke fill',
        textShadow: `0 ${3 * scale}px ${8 * scale}px rgba(0, 0, 0, 0.95), 0 0 ${20 * scale}px rgba(0, 0, 0, 0.75)`,
        overflowWrap: 'anywhere',
      }}
    >
      {selected.cue.words.map((word, index) => (
        <React.Fragment key={`${word.start}:${index}`}>
          {index > 0 ? ' ' : null}
          <span style={{ color: index === selected.activeWordIndex ? accentColor : textColor }}>
            {word.word}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
};
