/**
 * Demo film data — PURE and serializable: it is `inputProps` for the Remotion
 * composition and the frame-math input for the still script. No side effects;
 * the only import is the pure `hexToRgba` helper and the `FilmProps` type.
 *
 * A real project would import `@videomaker/motion-remotion` directly; this
 * demo is not a workspace package, so it reaches the kit through relative
 * paths (see `kit.ts`).
 */

import { hexToRgba } from '../../../../packages/motion-remotion/src/brand';
import type { FilmProps } from '../../../../packages/motion-remotion/src/types';

/** Local media assets committed with the project (manifest: id → file). */
export const demoAssets = [
  {
    id: 'placeholder-art',
    src: 'media/placeholder-art.png',
    width: 256,
    height: 256,
    duration: 0,
    sha256: 'e4987d10045742775b745f54ca702feb57b7cb30a3cbb54dee0e94c86e9878a5',
  },
] as const;

const DEMO_ACCENT = '#15803D';

export const demoFilmProps: FilmProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  // Project-local brand tokens: the demo's own line, not a product preset.
  branding: {
    brandName: 'Video Maker Demo',
    canvas: { from: '#FAF8F2', to: '#EFEBE0', angle: 165 },
    ink: '#14281C',
    accent: DEMO_ACCENT,
    glow: hexToRgba(DEMO_ACCENT, 0.1),
    brandGradient: { from: DEMO_ACCENT, to: '#0F766E' },
    mode: 'light',
    fontDisplay: 'Bricolage Grotesque',
    fontBody: 'Bricolage Grotesque',
    tagline: 'Escenas encadenadas, sin cortes de audio.',
    whenToUse: 'Composición de demostración del pipeline de video.',
  },
  scenes: [
    {
      id: 'intro',
      intent: 'title-motion',
      source: 'motion',
      durationInSeconds: 3,
      caption: 'Todo video es una cadena de escenas.',
      narration:
        'Un video se arma con escenas encadenadas, sin huecos entre cortes. La narración continua suena una sola vez.',
    },
    {
      id: 'asset-shot',
      intent: 'media-frame',
      source: 'motion',
      durationInSeconds: 3,
      caption: 'Los recursos viven en el proyecto.',
      narration:
        'Cada recurso se resuelve por id desde el manifiesto de assets, con su hash y sus medidas.',
      // Media binding: resolved through the film's AssetResolver manifest below
      // (`FilmProps.assets`) — the same id the still and the render both consume.
      assetId: 'placeholder-art',
    },
  ],
  // ONE continuous narration master, played exactly once across the film.
  narration: { src: 'media/narration.wav', durationSeconds: 6 },
  timingMode: 'continuous',
  assets: [...demoAssets],
};
