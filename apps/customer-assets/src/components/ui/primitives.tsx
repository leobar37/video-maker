/**
 * Shared UI primitives (contracts.md §8): accessible states for every async
 * surface — loading (spinner with label), empty, error — plus badges, a real
 * progress bar and a focus-managed modal. No client data or brand content
 * ever lives here.
 */

import { useEffect, useRef, type ReactNode } from 'react';

/** Shared inline-SVG icon family: 24px grid, 1.75 stroke, round caps. */
export function Icon({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconInbox({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Icon>
  );
}

export function IconAlert({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

export function IconUpload({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </Icon>
  );
}

export function IconPlay({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="m7 4.5 13 7.5-13 7.5z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconChevronLeft({ size = 16 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="state" data-testid="empty-state">
      <span className="state-icon">{icon ?? <IconInbox />}</span>
      <h3>{title}</h3>
      {hint !== undefined && <p>{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state" role="alert" data-testid="error-state">
      <span className="state-icon">
        <IconAlert />
      </span>
      <h3>Algo falló</h3>
      <p>{message}</p>
      {onRetry !== undefined && (
        <p>
          <button type="button" className="btn" onClick={onRetry}>Reintentar</button>
        </p>
      )}
    </div>
  );
}

export function ErrorBanner({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {children}
    </div>
  );
}

const BADGE_CLASS: Record<string, string> = {
  ok: 'badge badge-ok',
  hidden: 'badge badge-hidden',
  warn: 'badge badge-warn',
  plain: 'badge',
};

export function Badge({ tone = 'plain', children }: { tone?: keyof typeof BADGE_CLASS; children: ReactNode }) {
  return <span className={BADGE_CLASS[tone]}>{children}</span>;
}

export function ProgressBar({ loaded, total, label }: { loaded: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
    >
      <div className="progress-bar" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * Accessible modal: role=dialog + aria-modal, Escape closes, backdrop click
 * closes, and focus moves inside on open / back to the opener on close.
 */
export function Modal({
  title,
  onClose,
  children,
  closeLabel = 'Cerrar',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    surfaceRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={surfaceRef}
        tabIndex={-1}
      >
        <button type="button" className="btn btn-sm modal-close" onClick={onClose} aria-label={closeLabel}>
          ✕
        </button>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Human-readable byte size for display-only metadata. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Spanish short date for display-only metadata (13/10/2026). */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('es-AR');
}

/** Spanish medium date+time for display-only metadata (13 oct 2026, 1:02). */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}
