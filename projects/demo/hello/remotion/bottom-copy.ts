/**
 * The ONE bottom safe-zone line of a scene.
 *
 * `Caption` and `Subtitles` both anchor the same bottom safe zone (bottom
 * 180/170, keyline + display 800), so a scene must burn exactly one of them —
 * rendering both draws two texts on top of each other. Burned-in subtitles own
 * the zone whenever the scene has narration (the voice is the main channel on
 * mute, and the caption would only repeat it on screen); the lower-third
 * caption fills the zone only when there is no narration to caption.
 *
 * Pure decision logic, split from the scene components so it can be
 * unit-tested without pulling React/Remotion into the test runner.
 */

export type BottomCopy = 'subtitles' | 'caption' | null;

export function bottomLineFor(scene: { caption?: string; narration?: string }): BottomCopy {
  if (scene.narration?.trim()) return 'subtitles';
  if (scene.caption?.trim()) return 'caption';
  return null;
}
