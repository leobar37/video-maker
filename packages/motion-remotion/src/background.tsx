import React from 'react';
import { AbsoluteFill } from 'remotion';

import { canvasBackground, type BrandTokens } from './brand';

/**
 * Branding helpers: the standard scene background — warm canvas gradient plus
 * the subtle brand glow tint (top-right). The brand color is an accent here,
 * never a full-bleed wash.
 */
export const BrandBackground: React.FC<{
  branding: BrandTokens;
  /** Set `false` for restrained conceptual scenes. */
  glow?: boolean;
  /** Scene content layered over the background. */
  children?: React.ReactNode;
}> = ({ branding, glow = true, children }) => (
  <AbsoluteFill style={{ background: canvasBackground(branding) }}>
    {glow && branding.glow !== 'transparent' ? (
      <AbsoluteFill
        style={{
          background: `radial-gradient(110% 80% at 85% 8%, ${branding.glow} 0%, transparent 62%)`,
        }}
      />
    ) : null}
    {children}
  </AbsoluteFill>
);
