/**
 * `@videomaker/motion-core`: pure motion math for the video pipeline.
 *
 * Frame math, timing contracts and directed-camera planning — no React, no
 * Remotion, no I/O. Every consumer (Remotion sequencer, render CLI, tests)
 * speaks these types so the plan computed on one side is byte-for-byte the
 * plan executed on the other.
 */
export * from './camera';
export * from './frames';
export * from './spring';
export * from './timing';
