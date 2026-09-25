/**
 * The shared spring.
 *
 * Deliberately NOT `remotion`'s `spring()`. A planning CLI must be able to
 * compute and print the exact camera position of any frame without pulling
 * React into a Node context; if the CLI used a different curve than the
 * renderer, `--explain` would quietly lie. One implementation, both sides.
 *
 * Analytic solution of a damped harmonic oscillator from 0 to 1 with zero
 * initial velocity — the same physical model Remotion uses, evaluated in
 * closed form so it is deterministic and frame-order independent.
 */

export interface SpringConfig {
  mass: number;
  stiffness: number;
  damping: number;
}

/**
 * Critically damped: reaches the target as fast as possible WITHOUT
 * overshooting. A camera that wobbles past its target reads as a mistake, so
 * overshoot is not the default here (unlike Remotion's default config).
 */
export const CAMERA_SPRING: SpringConfig = { mass: 1, stiffness: 100, damping: 20 };

/** Raw spring displacement in [0, ~1) at time `t` seconds. */
export function springValue(t: number, config: SpringConfig = CAMERA_SPRING): number {
  if (t <= 0) return 0;
  const { mass, stiffness, damping } = config;
  if (mass <= 0 || stiffness <= 0 || damping < 0) {
    throw new Error('springValue: mass and stiffness must be > 0 and damping >= 0');
  }

  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (Math.abs(zeta - 1) < 1e-9) {
    // Critically damped.
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  }

  if (zeta < 1) {
    // Underdamped (overshoots).
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * omega * t) *
        (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t))
    );
  }

  // Overdamped (crawls in).
  const omegaD = omega * Math.sqrt(zeta * zeta - 1);
  return (
    1 -
    Math.exp(-zeta * omega * t) *
      (Math.cosh(omegaD * t) + ((zeta * omega) / omegaD) * Math.sinh(omegaD * t))
  );
}

/**
 * Spring progress over a FIXED window, normalised to land exactly on 1 at the
 * end of the window.
 *
 * A raw spring only approaches its target asymptotically, so a stage of finite
 * length would end at ~0.94 and snap the remaining 6% at the stage boundary —
 * a visible hitch. Dividing by the window's end value keeps the curve monotonic
 * and guarantees continuity between stages.
 *
 * Returns 0 at `frame <= 0` and 1 at `frame >= durationInFrames`.
 */
export function springProgress(
  frame: number,
  durationInFrames: number,
  fps: number,
  config: SpringConfig = CAMERA_SPRING,
): number {
  if (durationInFrames <= 0) return 1;
  if (frame <= 0) return 0;
  if (frame >= durationInFrames) return 1;

  const end = springValue(durationInFrames / fps, config);
  if (end <= 0) return 1;

  const value = springValue(frame / fps, config) / end;
  return Math.min(1, Math.max(0, value));
}
