/**
 * Per-route document titles (presentation only): sets `document.title` on
 * mount/param change and restores nothing (each page owns its title while
 * visible; the root route carries the default).
 */

import { useEffect } from 'react';

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
