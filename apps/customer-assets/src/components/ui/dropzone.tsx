/**
 * Shared upload drop-zone (presentation only): a real HTML5 drag & drop
 * surface (dragover highlight, multi-file drop) that degrades to the plain
 * click-to-pick file input on touch devices. It never touches the network —
 * validated `File` objects are handed to `onFiles` and each surface drives
 * its own upload pipeline (material XHR progress / guest-direct).
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { IconUpload } from './primitives';

function hasFiles(event: DragEvent<HTMLLabelElement>): boolean {
  const transfer = event.dataTransfer;
  if (transfer === null) return false;
  if (Array.from(transfer.types ?? []).includes('Files')) return true;
  return Array.from(transfer.items ?? []).some((item) => item.kind === 'file');
}

export function Dropzone({
  onFiles,
  accept,
  disabled = false,
  label = 'Elegir archivos',
  hint = 'o arrastralos hasta acá',
  inputTestId,
  children,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  disabled?: boolean;
  label?: string;
  hint?: string;
  inputTestId?: string;
  children?: ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave fire per child element; only clear when the pointer
  // really left the zone (depth back to zero).
  const depth = useRef(0);

  const onDragEnter = (event: DragEvent<HTMLLabelElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (event: DragEvent<HTMLLabelElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setDragOver(false);
    }
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragOver(false);
    if (disabled) return;
    const dropped = event.dataTransfer?.files;
    if (dropped !== undefined && dropped.length > 0) onFiles(Array.from(dropped));
  };

  const className = `upload-dropzone${dragOver ? ' is-dragover' : ''}`;

  return (
    <label
      className={className}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="dropzone-glyph" aria-hidden="true">
        <IconUpload size={20} />
      </span>
      {label}
      <span className="dropzone-hint">{hint}</span>
      <input
        type="file"
        multiple
        accept={accept}
        data-testid={inputTestId}
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(event) => {
          const chosen = event.target.files;
          if (chosen !== null && chosen.length > 0 && !disabled) onFiles(Array.from(chosen));
          event.target.value = '';
        }}
      />
      {children}
    </label>
  );
}
