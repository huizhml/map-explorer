import { useEffect, useState } from 'react';

/**
 * `useState` that survives reloads via localStorage. The stored value is used
 * only if it passes `isValid` (default: same `typeof` as `initial`), so stale
 * or hand-edited entries fall back to the default instead of breaking the UI.
 * Storage failures (private mode, quota, blocked site data) are ignored.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  isValid: (v: unknown) => boolean = (v) => typeof v === typeof initial,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) {
        const parsed: unknown = JSON.parse(raw);
        if (isValid(parsed)) return parsed as T;
      }
    } catch {
      /* ignore */
    }
    return initial;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/** Validator for string-literal unions: `oneOf(['png', 'jpg'])`. */
export function oneOf<T extends string>(options: readonly T[]) {
  return (v: unknown) => typeof v === 'string' && (options as readonly string[]).includes(v);
}
