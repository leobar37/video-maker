/**
 * Kit seam for the demo project.
 *
 * A real project would `import { Film, Subtitles, … } from
 * '@videomaker/motion-remotion'` and `import { filmTimingPlan } from
 * '@videomaker/motion-core'`. This demo lives outside the workspace packages,
 * so it re-exports the kits through relative paths — one seam, same API.
 */
export * from '../../../../packages/motion-core/src';
export * from '../../../../packages/motion-remotion/src';
