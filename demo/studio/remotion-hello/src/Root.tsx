import React from 'react';
import { Composition } from 'remotion';

import { HelloTitle } from './scenes/HelloTitle';

/**
 * Standalone editable Remotion project of the creative-workspace demo.
 * Self-contained: only `remotion` + `react` imports, no workspace packages,
 * so the folder keeps working wherever the agent copies it.
 */
export const FRAME_RATE = 30;
export const DURATION_IN_FRAMES = 90;
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Hello"
    component={HelloTitle}
    durationInFrames={DURATION_IN_FRAMES}
    fps={FRAME_RATE}
    width={VIDEO_WIDTH}
    height={VIDEO_HEIGHT}
    defaultProps={{ line: 'Taller creativo — snapshot sin renderer' }}
  />
);
