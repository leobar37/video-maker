import React from 'react';
import { Composition } from 'remotion';

import { demoFilmProps } from './demo-props';
import { Film, filmTimingPlan } from './kit';
// Side effect: registers the demo scene renderers (intent -> renderer).
import './scenes';

/**
 * The composition's frame count comes from the SHARED timing plan — the same
 * `filmTimingPlan` the Film sequencer and the still script consume. This is
 * the Root calculateMetadata authority: render and still cannot drift.
 */
const demoTimingInput = {
  fps: demoFilmProps.fps,
  scenes: demoFilmProps.scenes,
  timingMode: demoFilmProps.timingMode,
  narration: demoFilmProps.narration ?? null,
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Film"
    component={Film}
    durationInFrames={filmTimingPlan(demoTimingInput).totalFrames}
    fps={demoFilmProps.fps}
    width={demoFilmProps.width}
    height={demoFilmProps.height}
    defaultProps={demoFilmProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: filmTimingPlan({
        fps: props.fps,
        scenes: props.scenes,
        timingMode: props.timingMode,
        narration: props.narration ?? null,
      }).totalFrames,
    })}
  />
);
