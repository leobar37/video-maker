import { describe, expect, test } from 'bun:test';

import { AssetResolver, type AssetManifestEntry } from './assets';

const PNG_SHA = 'e4987d10045742775b745f54ca702feb57b7cb30a3cbb54dee0e94c86e9878a5';
const WAV_SHA = '71d93ef76e5ff6087d522277e83309f1d8d790e9b756324dec73d216ea57cc75';

const MANIFEST: AssetManifestEntry[] = [
  { id: 'art', src: 'media/art.png', width: 256, height: 256, duration: 0, sha256: PNG_SHA },
  {
    id: 'voice',
    src: 'media/voice.wav',
    width: 0,
    height: 0,
    duration: 6,
    sha256: WAV_SHA,
  },
];

describe('AssetResolver', () => {
  test('resolves ids to manifest entries and URLs', () => {
    const assets = new AssetResolver(MANIFEST, { toUrl: (src) => `/static/${src}` });
    expect(assets.has('art')).toBe(true);
    expect(assets.has('nope')).toBe(false);
    expect(assets.require('art')).toEqual(MANIFEST[0]);
    expect(assets.url('voice')).toBe('/static/media/voice.wav');
    expect(assets.resolve('art')).toEqual({
      entry: MANIFEST[0],
      url: '/static/media/art.png',
    });
    expect(assets.list().map((entry) => entry.id)).toEqual(['art', 'voice']);
  });

  test('defaults to identity resolution (raw public-relative src)', () => {
    const assets = new AssetResolver(MANIFEST);
    expect(assets.url('art')).toBe('media/art.png');
  });

  test('throws ASSET_UNKNOWN with the known ids', () => {
    const assets = new AssetResolver(MANIFEST);
    expect(() => assets.require('missing')).toThrow(/ASSET_UNKNOWN.*missing/);
    expect(() => assets.url('missing')).toThrow(/art, voice/);
  });

  test('rejects malformed manifests', () => {
    expect(() => new AssetResolver([{ ...MANIFEST[0]!, id: '' }])).toThrow(/without id/);
    expect(() =>
      new AssetResolver([MANIFEST[0]!, { ...MANIFEST[0]!, id: 'art' }]),
    ).toThrow(/duplicated/);
    expect(() =>
      new AssetResolver([{ ...MANIFEST[0]!, sha256: 'nope' }]),
    ).toThrow(/invalid sha256/);
    expect(() =>
      new AssetResolver([{ ...MANIFEST[0]!, duration: -1 }]),
    ).toThrow(/invalid duration/);
    expect(() =>
      new AssetResolver([{ ...MANIFEST[0]!, width: Number.NaN }]),
    ).toThrow(/invalid dimensions/);
    expect(() => new AssetResolver([{ ...MANIFEST[0]!, src: '' }])).toThrow(/no src/);
  });

  test('entries are copied by id — caller arrays are not shared', () => {
    const source: AssetManifestEntry[] = [{ ...MANIFEST[0]! }];
    const assets = new AssetResolver(source);
    source[0]!.src = 'mutated.png';
    expect(assets.require('art').src).toBe('media/art.png');
  });
});
