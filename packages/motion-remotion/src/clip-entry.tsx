/**
 * Remotion entry for `clip-render`: the composition side of a clip film.
 *
 * `runAssemble` bundles each project's own `remotion/index.ts`, whose Root
 * registers the project's scene renderers as an import side effect (see
 * `projects/demo/hello/remotion/Root.tsx`). A clip film is not a project
 * scene: it is an ordinary ONE-scene `Film` dispatched to the clip intents,
 * so `clip-render` bundles THIS module instead — it registers
 * `clip-vertical` / `clip-podcast` (the kit registers nothing implicitly)
 * and mounts the `Film` composition. `Film.tsx` and `render-adapter.ts` stay
 * untouched; this file only wires them together for clip renders.
 *
 * `calculateMetadata` derives `durationInFrames` from the SHARED
 * `filmTimingPlan` frame math — the same authority `clip-render` pins as
 * `expectedDurationInFrames` — so the full video render and the parity still
 * provably consume identical scene boundaries. The canvas defaults to the
 * pinned clip film size (1080×1920 @ 30 fps) and follows the `inputProps`
 * the CLI sends per render.
 */
import React from 'react';
import { Composition, registerRoot } from 'remotion';

import { filmTimingPlan } from '@videomaker/motion-core';

import { Film } from './Film';
import { resolveBrandTokens } from './brand';
import { registerClipIntents } from './clip-intents';
import type { FilmProps } from './types';

// Composition side: the scene registry must know the clip intents BEFORE the
// first Film scene dispatches through it.
registerClipIntents();

/** Fallback props for `Composition` typing; real renders always send inputProps. */
const defaultClipProps: FilmProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  branding: resolveBrandTokens('generic-elena'),
  timingMode: 'scene',
  scenes: [],
};

const ClipFilmRoot: React.FC = () => (
  <Composition
    id="Film"
    component={Film}
    durationInFrames={1}
    fps={defaultClipProps.fps}
    width={defaultClipProps.width}
    height={defaultClipProps.height}
    defaultProps={defaultClipProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: filmTimingPlan({
        fps: props.fps,
        scenes: props.scenes.map((scene) => ({
          durationInSeconds: scene.durationInSeconds,
          source: scene.source,
        })),
        timingMode: props.timingMode,
        narration: props.narration ?? null,
      }).totalFrames,
      width: props.width,
      height: props.height,
      fps: props.fps,
    })}
  />
);

registerRoot(ClipFilmRoot);
