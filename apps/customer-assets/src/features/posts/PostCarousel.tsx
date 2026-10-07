/**
 * Post presentation (FR-005): a carousel that preserves the delivered output
 * ORDER, marks the EXACT cover, and renders caption as plain text (React
 * escapes — client captions can never inject HTML). Shared by the posts page
 * and the Instagram detail modal.
 */

import { useState } from 'react';
import type { OutputRef, PostView } from '@videomaker/customer-assets';
import { Badge } from '../../components/ui/primitives';

export function outputContentUrl(deliveryId: string, output: OutputRef): string {
  return `/api/v1/deliveries/${deliveryId}/outputs/${output.name}`;
}

export function CarouselSlide({
  deliveryId,
  output,
  isCover,
}: {
  deliveryId: string;
  output: OutputRef;
  isCover: boolean;
}) {
  if (output.mediaType === 'video/mp4') {
    // Contract §8: MP4 without a poster gets an explicit placeholder — we
    // never promise or fake an auto-generated thumbnail.
    return (
      <div className="carousel-slide">
        <div className="video-placeholder" data-testid="video-placeholder">
          <span className="glyph" aria-hidden="true">▶</span>
          <span>Video (MP4)</span>
          <span>sin miniatura automática</span>
        </div>
        <p className="material-meta">
          {isCover && <Badge tone="warn">Portada</Badge>} {output.name} · {output.mediaType}
        </p>
      </div>
    );
  }
  return (
    <div className="carousel-slide">
      <img
        src={outputContentUrl(deliveryId, output)}
        alt={`${isCover ? 'Portada' : 'Salida'} ${output.name}`}
        loading="lazy"
      />
      <p className="material-meta">
        {isCover && <Badge tone="ok">Portada</Badge>} {output.name}
      </p>
    </div>
  );
}

export function PostCarousel({ post, deliveryId }: { post: PostView; deliveryId: string }) {
  const [index, setIndex] = useState(0);
  const safeIndex = Math.min(index, Math.max(0, post.outputs.length - 1));
  const current = post.outputs[safeIndex];
  if (current === undefined) return null;
  return (
    <div data-testid="post-carousel">
      <CarouselSlide deliveryId={deliveryId} output={current} isCover={current.name === post.cover.name} />
      <nav className="carousel-nav" aria-label={`Salidas de ${post.title}`}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={safeIndex === 0}
          onClick={() => setIndex(safeIndex - 1)}
          aria-label="Anterior"
        >
          ←
        </button>
        <span className="material-meta">
          {safeIndex + 1} / {post.outputs.length} · orden de entrega
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={safeIndex >= post.outputs.length - 1}
          onClick={() => setIndex(safeIndex + 1)}
          aria-label="Siguiente"
        >
          →
        </button>
      </nav>
      {post.outputs.length > 1 && (
        <div className="carousel-dots" aria-hidden="true">
          {post.outputs.map((output, dotIndex) => (
            <span key={output.name} className={`carousel-dot${dotIndex === safeIndex ? ' is-active' : ''}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CaptionBlock({ caption }: { caption: string | null }) {
  if (caption === null) return <p className="material-meta">Sin caption.</p>;
  // Plain text node — never HTML.
  return <p className="caption-text" data-testid="post-caption">{caption}</p>;
}
