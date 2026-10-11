/**
 * theme.ts — Tokens visuales del vertical `pi-codemode` (tema oscuro enérgico).
 *
 * NO reutiliza la paleta crema del tutorial `javascript-asincrono`: aquí el
 * lienzo es azul-noche, los paneles azul-petróleo y el contraste alto. Sólo
 * fuentes de sistema (DejaVu) y colores planos; ningún asset externo.
 */

export const theme = {
  /** Lienzo general. */
  bg: '#080C14',
  /** Paneles y tarjetas. */
  panel: '#111B29',
  /** Cabeceras de panel / superficies elevadas. */
  panelRaised: '#16263B',
  /** Bordes discretos. */
  border: '#22344C',
  /** Texto primario (blanco de alto contraste). */
  text: '#F2F6FF',
  /** Texto auxiliar legible. */
  muted: '#8FA3BE',
  /** Texto atenuado / futuro en captions. */
  dim: '#5C7089',
  /** Acento principal (cian). */
  cyan: '#4ED8F7',
  /** Acento secundario (lima). */
  lime: '#B6F24C',
  /** Reservado para advertencias (escena guard). */
  amber: '#F5B03A',
  mono: '"DejaVu Sans Mono", "Liberation Mono", monospace',
  sans: '"DejaVu Sans", Arial, sans-serif',
} as const;

/** Zonas seguras del lienzo vertical 1080×1920. */
export const SAFE = {
  top: 100,
  side: 72,
  bottom: 200,
} as const;
