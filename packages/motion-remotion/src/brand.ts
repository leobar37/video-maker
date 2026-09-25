/**
 * Shared visual brand tokens (Standard v1).
 *
 * Cross-product design contract for the video pipeline: every Remotion scene
 * consumes these tokens instead of hardcoding colors. The brand color lives in
 * the *accent* (keylines, glows, small chips, the phone halo) — NEVER as a
 * full-bleed background. The canvas is a warm, near-neutral surface; the CTA is
 * the only place that may use the full brand gradient.
 *
 * Presets are plain data: resolution is `resolveBrandTokens(presetName)`.
 * Add a new product by exporting another `BrandTokens` preset below.
 */

export interface BrandTokens {
  /**
   * Product name as it appears on screen (wordmark, brand lockups).
   *
   * Part of the token on purpose: it used to be typed directly into shared
   * scenes, which made those scenes silently single-product.
   */
  brandName: string;
  /** Warm canvas surface (light mode). Two-stop linear gradient. Never pure white. */
  canvas: { from: string; to: string; angle: number };
  /** Ink color for text/graphics drawn on the canvas. */
  ink: string;
  /** Brand accent — used for keylines, glows, halos and small chips (accent, not canvas). */
  accent: string;
  /** Subtle radial glow tint layered over the canvas (top-right). */
  glow: string;
  /** Full brand gradient — reserved for the CTA scene only. */
  brandGradient: { from: string; to: string };
  /** Opt-out for restrained conceptual videos; omitted by existing presets. */
  visualEffects?: 'none';
  /** Rendering mode; drives contrast decisions in components. */
  mode: 'light' | 'dark';
  /** Display family (wordmark, captions, titles). */
  fontDisplay: string;
  /** Body family (secondary copy). */
  fontBody: string;
  /** Product tagline. */
  tagline: string;
  /**
   * Cuándo usar esta línea. Vive en el token, no en un comentario: el que
   * elige el preset (humano o agente) necesita saber a qué audiencia sirve
   * sin abrir este archivo ni adivinarlo por los colores.
   */
  whenToUse: string;
  /**
   * Línea base de la que deriva este preset (`generic-elena` para los canales
   * que heredan la estética genérica). Ausente = línea original.
   */
  derivedFrom?: string;
  /**
   * Perfil de publicación por defecto de esta línea (grupo de cuentas).
   * Ausente = `default`. Un video puede sobreescribirlo por configuración.
   */
  publicationProfile?: string;
}

/**
 * Standard subtlety of the halo behind the device. The brand is an accent, so
 * the glow is a hint of it, never a wash.
 */
const GLOW_ALPHA = 0.1;

const AVILEO_ACCENT = '#F97316';

/** Avileo — small-business digital notebook. */
export const avileoTokens: BrandTokens = {
  whenToUse:
    'Videos de Avileo: producto y canal del cuaderno digital para mypes y bodegueros peruanos.',
  brandName: 'Avileo',
  canvas: { from: '#FBF9F6', to: '#F1ECE4', angle: 165 },
  ink: '#1C1917',
  accent: AVILEO_ACCENT,
  glow: hexToRgba(AVILEO_ACCENT, GLOW_ALPHA),
  brandGradient: { from: AVILEO_ACCENT, to: '#FBBF24' },
  mode: 'light',
  fontDisplay: 'Bricolage Grotesque',
  fontBody: 'Bricolage Grotesque',
  tagline: 'Tu negocio, siempre a mano.',
};

const ELENA_ACCENT = '#FF9500';

/**
 * Elena — restaurant management.
 *
 * `brandName`, `accent`, `ink`, `canvas.from` and `tagline` are NOT invented
 * here: they are the product's real brand (Amber Elena #FF9500, Carbon
 * #5A3A1F, Rice #FFF9EF). A test asserts the values still match the product's
 * brand source of truth, so a copy cannot rot unnoticed.
 *
 * What IS decided here is editorial and belongs to the video standard: how the
 * canvas deepens, how strong the halo is, where the CTA gradient lands, and the
 * typeface shared by every video.
 */
export const elenaTokens: BrandTokens = {
  whenToUse:
    'Videos de Elena: producto y canal del sistema para restaurantes (POS, cartas, pedidos).',
  brandName: 'Elena',
  canvas: { from: '#FFF9EF', to: '#F6EADA', angle: 165 },
  ink: '#5A3A1F',
  accent: ELENA_ACCENT,
  glow: hexToRgba(ELENA_ACCENT, GLOW_ALPHA),
  brandGradient: { from: ELENA_ACCENT, to: '#FFC048' },
  mode: 'light',
  fontDisplay: 'Bricolage Grotesque',
  fontBody: 'Bricolage Grotesque',
  tagline: 'Tu restaurante, bajo control.',
};

const GYMSPACE_PRIMARY = '#F57E24';
const GYMSPACE_SECONDARY = '#00A1CA';

/**
 * GymSpace — gym & fitness management.
 *
 * `brandName`, `accent`, `ink`, `canvas.from` and `tagline` are NOT invented
 * here: they come from the product's real app theme and catalog brand color.
 *
 * Editorial decisions that belong to the video standard: GymSpace is a
 * dark-first product, so the canvas is the app's dark surface (unlike the
 * light Avileo/Elena canvases) and the CTA gradient runs primary → secondary
 * (orange → cyan), the two real brand colors.
 */
export const gymspaceTokens: BrandTokens = {
  whenToUse:
    'Videos de GymSpace: producto y canal del sistema para gimnasios (membresías, asistencias).',
  brandName: 'GymSpace',
  canvas: { from: '#0C0A09', to: '#151312', angle: 165 },
  ink: '#FAFAF9',
  accent: GYMSPACE_PRIMARY,
  glow: hexToRgba(GYMSPACE_PRIMARY, GLOW_ALPHA),
  brandGradient: { from: GYMSPACE_PRIMARY, to: GYMSPACE_SECONDARY },
  mode: 'dark',
  fontDisplay: 'Bricolage Grotesque',
  fontBody: 'Bricolage Grotesque',
  tagline: 'Tu gimnasio, bajo control.',
};

export const leoTokens: BrandTokens = {
  whenToUse:
    'Videos conceptuales técnicos: explica cómo construimos, sin producto.',
  brandName: 'Leo',
  canvas: { from: '#242422', to: '#242422', angle: 0 },
  ink: '#F2EEE5',
  accent: '#B9A588',
  glow: 'transparent',
  brandGradient: { from: '#242422', to: '#242422' },
  mode: 'dark',
  visualEffects: 'none',
  fontDisplay: 'Bricolage Grotesque',
  fontBody: 'Bricolage Grotesque',
  tagline: 'IA explicada en práctica.',
};

const GENERIC_ELENA_ACCENT = '#15803D';

/**
 * `generic-elena` — línea base de contenido educativo.
 *
 * Paper-ledger feel: warm cream canvas, green-tinted ink, money-green accent.
 * No vende un producto: explica. Los canales que la usan la heredan y
 * sobreescriben `brandName` y `tagline` (ver `cuentasClarasTokens`), de modo
 * que la estética vive en un solo lugar. Same contract as the products: accent
 * only, CTA owns the brand gradient.
 */
export const genericElenaTokens: BrandTokens = {
  whenToUse:
    'Contenido educativo genérico: explica un concepto o un oficio (finanzas, gestión, tecnología) sin empujar un producto. Es la base de los canales; al usarla directo, definí brandName y tagline.',
  brandName: 'Elena Tech',
  canvas: { from: '#FAF8F2', to: '#EFEBE0', angle: 165 },
  ink: '#14281C',
  accent: GENERIC_ELENA_ACCENT,
  glow: hexToRgba(GENERIC_ELENA_ACCENT, GLOW_ALPHA),
  brandGradient: { from: GENERIC_ELENA_ACCENT, to: '#0F766E' },
  mode: 'light',
  fontDisplay: 'Bricolage Grotesque',
  fontBody: 'Bricolage Grotesque',
  tagline: 'Aprende a manejar tu negocio.',
};

/**
 * Cuentas Claras — canal de finanzas y gestión para emprendedores LATAM.
 * Hereda la estética de `generic-elena` y aporta su propia marca: es el
 * canal, no la línea de diseño.
 */
export const cuentasClarasTokens: BrandTokens = {
  ...genericElenaTokens,
  whenToUse:
    'Canal Cuentas Claras: videos de finanzas y gestión para emprendedores LATAM (bodegueros, mypes). Hereda la estética de generic-elena.',
  derivedFrom: 'generic-elena',
  brandName: 'Cuentas Claras',
  tagline: 'Finanzas claras para tu negocio.',
};

/**
 * Café Élite — cliente real de café de especialidad orgánico de San Ignacio,
 * Perú. A diferencia de los productos digitales, esta marca no usa el
 * gradiente estándar del pipeline: el dossier define superficies sólidas,
 * fotografía cálida y contraste editorial verde petróleo/crema.
 *
 * Los pares `from/to` son iguales a propósito. `canvasBackground()` los
 * resuelve como colores sólidos y evita que componentes compartidos
 * reintroduzcan gradientes en futuros videos del cliente.
 */
const ELITE_COFFEE_GREEN = '#1D3B34';

export const eliteCoffeeTokens: BrandTokens = {
  whenToUse:
    'Videos de Café Élite: cliente real de café orgánico de especialidad (San Ignacio, Perú). Producto con fotos de empaques reales; tono cálido de origen y familia.',
  brandName: 'Café Élite',
  canvas: { from: '#F5F0E8', to: '#F5F0E8', angle: 0 },
  ink: ELITE_COFFEE_GREEN,
  accent: '#C79A5A',
  glow: 'rgba(0, 0, 0, 0)',
  brandGradient: { from: ELITE_COFFEE_GREEN, to: ELITE_COFFEE_GREEN },
  mode: 'light',
  fontDisplay: 'Cormorant Garamond',
  fontBody: 'Bricolage Grotesque',
  tagline: 'Elevando tu experiencia.',
};

/**
 * Rafael — personaje de campaña "Rafael Hulk" (gigante verde anti-corrupción).
 *
 * No es un producto ni un canal: es un personaje de campaña con avatar IA
 * (foto real del candidato transformada; disclosure "IA" obligatorio en
 * pantalla). Los verdes NO se inventan a ojo: salen de las referencias
 * visuales aprobadas por el operador (muestreo dominante ≈ #204830–#285840,
 * verde bosque del personaje). El accent las eleva en luminosidad (#2F7A45)
 * para que las keylines lean sobre el lienzo cálido del estándar, y el
 * gradiente de CTA aterriza de vuelta en el verde bosque profundo (#1B4D2E).
 */
const RAFAEL_GREEN = '#2F7A45';
const RAFAEL_FOREST = '#1B4D2E';

export const rafaelTokens: BrandTokens = {
  whenToUse:
    'Videos del personaje de campaña Rafael Hulk (gigante verde anti-corrupción, avatar IA sobre foto real del candidato). Tuteo LATAM; disclosure IA obligatorio.',
  brandName: 'Rafael',
  canvas: { from: '#F8F9F2', to: '#EEF2E4', angle: 165 },
  ink: '#14241A',
  accent: RAFAEL_GREEN,
  glow: hexToRgba(RAFAEL_GREEN, GLOW_ALPHA),
  brandGradient: { from: RAFAEL_GREEN, to: RAFAEL_FOREST },
  mode: 'light',
  fontDisplay: 'Bricolage Grotesque',
  fontBody: 'Bricolage Grotesque',
  tagline: 'El gigante verde contra la corrupción.',
};

/** Registry of available presets, keyed by the `branding.preset` in a project's config. */
export const brandPresets = {
  avileo: avileoTokens,
  elena: elenaTokens,
  gymspace: gymspaceTokens,
  leo: leoTokens,
  // Línea base educativa; los canales la heredan.
  'generic-elena': genericElenaTokens,
  'cuentas-claras': cuentasClarasTokens,
  'elite-coffee': eliteCoffeeTokens,
  // Personaje de campaña "Rafael Hulk" (avatar IA).
  rafael: rafaelTokens,
  // Alias histórico: mismo preset, nombre viejo.
  edu: cuentasClarasTokens,
} satisfies Record<string, BrandTokens>;

export type BrandPreset = keyof typeof brandPresets;

/** Resolve a preset name to its tokens (throws on unknown preset). */
export function resolveBrandTokens(preset: string): BrandTokens {
  const tokens = (brandPresets as Record<string, BrandTokens>)[preset];
  if (!tokens) {
    const known = Object.keys(brandPresets).join(', ');
    throw new Error(`Unknown brand preset "${preset}". Known presets: ${known}`);
  }
  return tokens;
}

/** Canvas CSS for the current tokens; equal stops intentionally mean solid. */
export function canvasBackground(t: BrandTokens): string {
  return t.canvas.from === t.canvas.to
    ? t.canvas.from
    : `linear-gradient(${t.canvas.angle}deg, ${t.canvas.from} 0%, ${t.canvas.to} 100%)`;
}

/** Full brand CSS gradient (CTA only). */
export function brandBackground(t: BrandTokens): string {
  return t.visualEffects === 'none'
    ? t.brandGradient.from
    : `linear-gradient(155deg, ${t.brandGradient.from} 0%, ${t.brandGradient.to} 100%)`;
}

/** Convert a #rrggbb hex to an rgba() string at the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
