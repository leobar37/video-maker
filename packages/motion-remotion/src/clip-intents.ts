/**
 * Registration entry point for the clip intents: a clip film is an ordinary
 * `Film` of one `source: 'clip'` scene, dispatched to `clip-vertical` (single)
 * or `clip-podcast` (duo) through the scene registry. Call once before
 * rendering (project code / composition bootstrap) — the kit registers
 * nothing implicitly.
 */

import { ClipPodcast } from './ClipPodcast';
import { ClipVertical } from './ClipVertical';
import { registerScene } from './SceneRenderer';

export function registerClipIntents(): void {
  registerScene('clip-vertical', ClipVertical);
  registerScene('clip-podcast', ClipPodcast);
}
