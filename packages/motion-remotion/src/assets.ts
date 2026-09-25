/**
 * Asset resolution: a serializable manifest replaces `staticFile('<scene>/media/…')`
 * literals and `getStaticFiles()` scanning.
 *
 * Every committed media file is declared once — id, path, intrinsic size, real
 * duration and sha256 — and referenced by id from scene data. The manifest is
 * plain JSON, so it travels in `FilmProps` and both the CLI and the renderer
 * resolve the same file. Pure module: URL resolution is an injected `toUrl`
 * (bind Remotion's `staticFile` inside a composition, identity elsewhere).
 */

export interface AssetManifestEntry {
  /** Stable id used by scenes (`FilmScene.assetId`). */
  id: string;
  /** Path relative to the composition's public directory. */
  src: string;
  /** Intrinsic width in pixels (0 for audio-only assets). */
  width: number;
  /** Intrinsic height in pixels (0 for audio-only assets). */
  height: number;
  /** Real media duration in seconds (0 for stills). */
  duration: number;
  /** SHA-256 of the committed file, lowercase hex. */
  sha256: string;
}

/** Maps a manifest `src` to a playable URL (e.g. Remotion's `staticFile`). */
export type AssetUrlFn = (src: string) => string;

const identityUrl: AssetUrlFn = (src) => src;

/**
 * Lookup over an asset manifest. Construction validates the manifest; `url()`
 * resolves ids through the injected `toUrl`.
 */
export class AssetResolver {
  private readonly byId: Map<string, AssetManifestEntry>;
  private readonly toUrl: AssetUrlFn;

  constructor(entries: readonly AssetManifestEntry[], options: { toUrl?: AssetUrlFn } = {}) {
    this.byId = new Map();
    for (const entry of entries) {
      if (!entry.id) throw new Error('AssetResolver: manifest entry without id.');
      if (!entry.src) throw new Error(`AssetResolver: asset "${entry.id}" has no src.`);
      if (this.byId.has(entry.id)) {
        throw new Error(`AssetResolver: duplicated asset id "${entry.id}".`);
      }
      if (
        !Number.isFinite(entry.width) ||
        entry.width < 0 ||
        !Number.isFinite(entry.height) ||
        entry.height < 0
      ) {
        throw new Error(`AssetResolver: asset "${entry.id}" has invalid dimensions.`);
      }
      if (!Number.isFinite(entry.duration) || entry.duration < 0) {
        throw new Error(`AssetResolver: asset "${entry.id}" has invalid duration.`);
      }
      if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error(`AssetResolver: asset "${entry.id}" has an invalid sha256.`);
      }
      // Copy the entry: caller-side mutations of the manifest array must not
      // reach the resolved assets.
      this.byId.set(entry.id, { ...entry });
    }
    this.toUrl = options.toUrl ?? identityUrl;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Manifest entry for `id`; throws `ASSET_UNKNOWN` when missing. */
  require(id: string): AssetManifestEntry {
    const entry = this.byId.get(id);
    if (!entry) {
      const known = [...this.byId.keys()].join(', ') || '(none)';
      throw new Error(`ASSET_UNKNOWN: asset "${id}" is not in the manifest. Known ids: ${known}`);
    }
    return entry;
  }

  /** Playable URL for `id`, resolved through the injected `toUrl`. */
  url(id: string): string {
    return this.toUrl(this.require(id).src);
  }

  /** Entry + playable URL in one lookup. */
  resolve(id: string): { entry: AssetManifestEntry; url: string } {
    const entry = this.require(id);
    return { entry, url: this.toUrl(entry.src) };
  }

  /** All manifest entries, in declaration order. */
  list(): AssetManifestEntry[] {
    return [...this.byId.values()];
  }
}
