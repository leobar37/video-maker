export const DEMO_FPS = 30;
export const CHAPTER_FRAMES = 240;
export const DEMO_CHAPTERS = [
  { label: 'Terminal', component: 'TerminalWindow' },
  { label: 'Código', component: 'CodePanel' },
  { label: 'Video', component: 'ScreenRecording' },
  { label: 'Kit', component: 'TutorialLayout + Callout' },
] as const;
export const DEMO_FRAMES = CHAPTER_FRAMES * DEMO_CHAPTERS.length;
export type DemoFormat = 'horizontal' | 'vertical';

export const DEMO_FORMATS: Record<DemoFormat, {
  label: string;
  compositionId: string;
  width: number;
  height: number;
  video: string;
  stillPrefix: string;
  sampleId: string;
  sampleVideo: string;
  sampleWidth: number;
  sampleHeight: number;
}> = {
  horizontal: {
    label: 'Horizontal · 16:9', compositionId: 'OpenCodeDemo', width: 1920, height: 1080,
    video: 'opencode-demo.mp4', stillPrefix: 'chapter-', sampleId: 'TerminalSample',
    sampleVideo: 'terminal-sample.mp4', sampleWidth: 1600, sampleHeight: 720,
  },
  vertical: {
    label: 'Vertical · 9:16', compositionId: 'OpenCodeDemoVertical', width: 1080, height: 1920,
    video: 'opencode-demo-vertical.mp4', stillPrefix: 'vertical-chapter-', sampleId: 'TerminalSampleVertical',
    sampleVideo: 'terminal-sample-vertical.mp4', sampleWidth: 1000, sampleHeight: 1100,
  },
};

export function parseDemoArgs(args: readonly string[]): {
  formats: DemoFormat[];
  stillsOnly: boolean;
  catalogOnly: boolean;
} {
  let format: DemoFormat | 'all' = 'all';
  let stillsOnly = false;
  let catalogOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--stills') stillsOnly = true;
    else if (arg === '--catalog-only') catalogOnly = true;
    else if (arg === '--format') {
      const value = args[++index];
      if (value !== 'all' && value !== 'horizontal' && value !== 'vertical') {
        throw new Error('--format must be horizontal, vertical or all');
      }
      format = value;
    } else {
      throw new Error(`Unknown tutorial option: ${arg}`);
    }
  }
  return { formats: format === 'all' ? ['horizontal', 'vertical'] : [format], stillsOnly, catalogOnly };
}
