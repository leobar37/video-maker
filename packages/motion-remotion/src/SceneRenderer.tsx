import React from 'react';

import type { SceneSpan } from '@videomaker/motion-core';

import { AssetResolver } from './assets';
import type { FilmBranding, FilmScene, FilmSceneSource } from './types';

/** What every registered scene renderer receives. */
export interface SceneRenderProps {
  scene: FilmScene;
  branding: FilmBranding;
  /** Resolves `scene.assetId` against `FilmProps.assets` (bound to `staticFile`). */
  assets: AssetResolver;
  /** The scene's exact half-open frame span from the shared timing plan. */
  span: SceneSpan;
}

/**
 * A scene renderer draws ONE scene's visuals. Audio is never rendered here —
 * `Film` owns the narration master and per-scene audio so nothing can be
 * duplicated. `supportedSources` is an explicit template capability: a
 * renderer that only knows how to draw captures can refuse avatar scenes.
 */
export type SceneRendererComponent = React.ComponentType<SceneRenderProps> & {
  supportedSources?: readonly FilmSceneSource[];
};

/**
 * The scene registry: project code registers one renderer per scene `intent`
 * (`registerScene(id, renderer)`), and `SceneRenderer` dispatches each scene to
 * its renderer at render time. The kit ships primitives only — bespoke scene
 * authoring stays project code.
 */
const sceneRenderers = new Map<string, SceneRendererComponent>();

export function registerScene(intent: string, renderer: SceneRendererComponent): void {
  if (!intent) throw new Error('registerScene: intent must be a non-empty string.');
  sceneRenderers.set(intent, renderer);
}

export function getSceneRenderer(intent: string): SceneRendererComponent | undefined {
  return sceneRenderers.get(intent);
}

export function unregisterScene(intent: string): boolean {
  return sceneRenderers.delete(intent);
}

export function clearSceneRegistry(): void {
  sceneRenderers.clear();
}

export function registeredSceneIntents(): string[] {
  return [...sceneRenderers.keys()];
}

/**
 * Renders one scene by dispatching on `scene.intent` through the registry.
 * Throws loudly on a missing renderer or an unsupported scene source — a
 * silent fallback would render the wrong template.
 */
export const SceneRenderer: React.FC<SceneRenderProps> = ({ scene, branding, assets, span }) => {
  const renderer = getSceneRenderer(scene.intent);
  if (!renderer) {
    throw new Error(
      `SCENE_RENDERER_UNREGISTERED: no renderer for intent "${scene.intent}" ` +
        `(scene "${scene.id}"). Call registerScene("${scene.intent}", Renderer) before rendering.`,
    );
  }
  if (renderer.supportedSources && !renderer.supportedSources.includes(scene.source)) {
    throw new Error(
      `SCENE_SOURCE_UNSUPPORTED: renderer "${scene.intent}" does not support source ` +
        `"${scene.source}" (scene "${scene.id}").`,
    );
  }
  const Component = renderer;
  return <Component scene={scene} branding={branding} assets={assets} span={span} />;
};
