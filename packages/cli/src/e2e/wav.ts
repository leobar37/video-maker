/**
 * Canonical PCM WAV encoder (pure, deterministic): a 44-byte RIFF header plus
 * 16-bit samples. The offline e2e path synthesizes narration and music-bed
 * audio without network, providers or even ffmpeg — every byte is reproducible
 * so tests can assert exact output and `sha256` provenance stays stable.
 */

export interface WavFormat {
  sampleRate: number;
  channels: number;
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

/** Encodes 16-bit PCM samples as a standard WAV file. */
export function encodePcm16Wav(samples: Int16Array, format: WavFormat): Uint8Array {
  const { sampleRate, channels } = format;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodePcm16Wav: invalid sampleRate ${sampleRate}.`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`encodePcm16Wav: invalid channels ${channels}.`);
  }
  if (samples.length % channels !== 0) {
    throw new Error(
      `encodePcm16Wav: ${samples.length} samples is not a multiple of ${channels} channel(s).`,
    );
  }
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x52); // 'RIFF'
  view.setUint8(1, 0x49);
  view.setUint8(2, 0x46);
  view.setUint8(3, 0x46);
  u32(view, 4, 36 + dataBytes);
  view.setUint8(8, 0x57); // 'WAVE'
  view.setUint8(9, 0x41);
  view.setUint8(10, 0x56);
  view.setUint8(11, 0x45);
  view.setUint8(12, 0x66); // 'fmt '
  view.setUint8(13, 0x6d);
  view.setUint8(14, 0x74);
  view.setUint8(15, 0x20);
  u32(view, 16, 16); // fmt chunk size
  u16(view, 20, 1); // PCM
  u16(view, 22, channels);
  u32(view, 24, sampleRate);
  u32(view, 28, sampleRate * channels * 2); // byte rate
  u16(view, 32, channels * 2); // block align
  u16(view, 34, 16); // bits per sample
  view.setUint8(36, 0x64); // 'data'
  view.setUint8(37, 0x61);
  view.setUint8(38, 0x74);
  view.setUint8(39, 0x61);
  u32(view, 40, dataBytes);

  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return bytes;
}
