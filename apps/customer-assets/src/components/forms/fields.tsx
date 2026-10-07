/**
 * Form primitives (contracts.md §8): every form field wraps label/input/error
 * with accessible wiring (`htmlFor`, `aria-invalid`, `aria-describedby`) and
 * validation goes through Zod schemas shared by the submit handlers.
 */

import { useId, type ChangeEvent, type ReactNode } from 'react';
import type { ZodType } from 'zod';

export interface FieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'numeric';
}

export function TextField({
  label,
  name,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  error,
  required,
  autoComplete,
  inputMode,
}: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">
        {label}
        {required === true && <span aria-hidden="true"> *</span>}
      </span>
      <input
        id={id}
        name={name}
        className="field-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
      />
      {hint !== undefined && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      )}
    </label>
  );
}

export function TextAreaField({
  label,
  name,
  value,
  onChange,
  hint,
  error,
  rows = 3,
  maxLength,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <textarea
        id={id}
        name={name}
        className="field-textarea"
        rows={rows}
        maxLength={maxLength}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
      />
      {hint !== undefined && <span className="field-hint">{hint}</span>}
      {error !== undefined && (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      )}
    </label>
  );
}

/**
 * Validates `values` against a Zod schema and returns either the parsed data
 * or a field->message map (first issue per field). Submit handlers call this
 * so invalid payloads never reach the network.
 */
export function validateWith<T>(schema: ZodType<T>, values: Record<string, unknown>): { data: T } | { fieldErrors: Record<string, string> } {
  const outcome = schema.safeParse(values);
  if (outcome.success) return { data: outcome.data };
  const fieldErrors: Record<string, string> = {};
  for (const issue of outcome.error.issues) {
    const key = issue.path.map(String).join('.') || '_form';
    if (fieldErrors[key] === undefined) fieldErrors[key] = issue.message;
  }
  return { fieldErrors };
}

export function FormActions({ children }: { children?: ReactNode }) {
  return <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>{children}</div>;
}
