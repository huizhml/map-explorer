import { useEffect, useId, useRef, useState } from 'react';
import type { BasemapId } from './SimpleControls';
import { BASEMAPS } from './SimpleControls';

/**
 * Mirrors the full app's BaseMapSelector: a compact card pinned bottom-right
 * showing the current basemap, opening a menu on click — not a row of buttons
 * competing with the map for attention.
 *
 * Rebuilt in plain CSS rather than reused, because that component is built on
 * MUI's Paper/Menu/IconButton and this page has no MUI.
 */
export function BasemapControl({
  value,
  onChange,
}: {
  value: BasemapId;
  onChange: (id: BasemapId) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const ref = useRef<HTMLDivElement | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // A disclosure, not an ARIA menu: role="menu" promises arrow-key navigation,
  // which a three-item list does not need. Not a popover either: the list sits
  // above its trigger by plain layout, and in the top layer it would need JS
  // positioning (CSS anchor positioning is not available everywhere yet).
  // Close on outside click and on Escape; Escape hands focus back to the trigger
  // so it is not stranded on a button that just disappeared.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ref.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = BASEMAPS.find((b) => b.id === value) ?? BASEMAPS[0];

  return (
    <div className="ex-basemap" ref={ref}>
      {open && (
        <ul className="ex-basemap__menu" id={listId} aria-label="Base map">
          {BASEMAPS.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                aria-pressed={b.id === value}
                className={b.id === value ? 'is-active' : undefined}
                onClick={() => {
                  onChange(b.id);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                {b.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="ex-basemap__trigger"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title="Select base map"
      >
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 3 2 8.5 12 14l10-5.5L12 3Zm7.8 8.2L12 15.5 4.2 11.2 2 12.4 12 18l10-5.6-2.2-1.2Z"
          />
        </svg>
        <span>{current.label}</span>
      </button>
    </div>
  );
}
