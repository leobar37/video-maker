export interface AsyncScene {
  id: string;
  title: string;
  eyebrow: string;
  visual: 'code' | 'timeline' | 'event-loop' | 'promise';
  narration: string;
  code: string;
  expectedOutput: string[];
  callout: string;
}

export interface AsyncScript {
  schemaVersion: 1;
  id: string;
  title: string;
  language: string;
  voiceDirection: string;
  scenes: AsyncScene[];
}

export interface VoiceChoice {
  voiceId: string;
  voiceName: string;
  modelId: 'eleven_v4';
  language: 'es';
  usePvcAsIvc: boolean;
  voiceSettings: { stability: number; similarity_boost: number };
}

export interface NarrationMeta {
  schemaVersion: 1;
  requestFingerprint: string;
  voice: VoiceChoice;
  text: string;
  durationSeconds: number;
  wavSha256: string;
  scenes: Array<{ sceneId: string; startSeconds: number; endSeconds: number; durationSeconds: number }>;
  words: Array<{ word: string; start: number; end: number }>;
}

export interface DemoEvidence {
  schemaVersion: 1;
  runtime: string;
  nodeVersion: string;
  verifiedAt: string;
  scenes: Array<{
    id: string;
    codeSha256: string;
    expectedOutput: string[];
    actualOutput: string[];
    passed: boolean;
    kind: 'executed' | 'conceptual';
    measurements?: { sequentialMs: number; concurrentMs: number };
  }>;
}
