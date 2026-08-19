import { useEffect, useRef, useState } from 'react';

/**
 * True when there is no room beside the figure for the prose — the point at
 * which the slide stacks instead of overlaying, and the figures crop their
 * empty third away.
 */
export function useNarrow(query = '(max-width: 860px)') {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return narrow;
}

/** Ease-in-out. Shared so the two figures move at the same character. */
export const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));

/**
 * Ease towards `target` over time, so a tap on the arrow key animates rather
 * than cuts. A live drag overrides it — nothing should lag behind a finger that
 * is still on the screen — and reduced motion skips it entirely.
 */
export function useTween(target: number, immediate: boolean, ms = 850) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  current.current = value;

  useEffect(() => {
    if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }
    const from = current.current;
    if (Math.abs(from - target) < 1e-4) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now: number) {
      const t = Math.min(1, (now - start) / ms);
      setValue(from + (target - from) * ease(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, immediate, ms]);

  return value;
}
