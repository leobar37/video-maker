/**
 * Segmented control tabs (presentation only): the active segment is marked
 * with aria-current exactly as before, and a sliding indicator pill is
 * positioned behind it (transform/width only; disabled under
 * prefers-reduced-motion via the shared stylesheet).
 */

import { useEffect, useRef } from 'react';
import { Link, useLocation } from '@tanstack/react-router';

export interface SegmentTab {
  segment: string;
  to: string;
  label: string;
}

export function SegmentedTabs({
  tabs,
  clientId,
  'aria-label': ariaLabel,
}: {
  tabs: readonly SegmentTab[];
  clientId: string;
  'aria-label': string;
}) {
  const location = useLocation();
  const listRef = useRef<HTMLElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);

  const currentPath = location.pathname;
  useEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (list === null || indicator === null) return;
    const active = list.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
    if (active === null) {
      indicator.classList.remove('is-ready');
      return;
    }
    const position = () => {
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.transform = `translateX(${active.offsetLeft}px)`;
      indicator.classList.add('is-ready');
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(list);
    if (document.fonts !== undefined) {
      void document.fonts.ready.then(position).catch(() => undefined);
    }
    return () => observer.disconnect();
  }, [currentPath]);

  return (
    <nav className="tabbar" aria-label={ariaLabel} ref={listRef}>
      <span className="tabbar-indicator" ref={indicatorRef} aria-hidden="true" />
      {tabs.map((tab) => (
        <Link
          key={tab.segment}
          to={tab.to}
          params={{ clientId }}
          aria-current={currentPath === tab.to.replace('$clientId', clientId) ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
