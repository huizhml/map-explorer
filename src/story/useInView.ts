import { useEffect, useRef, useState } from 'react';

/**
 * Counts up to `value` once its slide becomes the active one, then stops.
 * Respects prefers-reduced-motion by jumping straight to the final value.
 *
 * This used to watch for the element intersecting the viewport. In a deck the
 * slides are all laid out and merely translated out of frame, so "on screen"
 * is the deck's business, not the browser's — being told when it is our turn is
 * both simpler and the only thing that is actually true.
 */
export function useCountUp(value: number, active: boolean, durationMs = 1200) {
  const [display, setDisplay] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (!active || done.current) return;
    done.current = true;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(value);
      return;
    }

    const start = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic: fast start, settles on the number
      setDisplay(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, value, durationMs]);

  return display;
}
