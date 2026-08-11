import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Which chapter is active, and how far it has scrolled — from one measurement.
 *
 * These were two mechanisms: an IntersectionObserver for the active chapter and
 * a separate scroll listener for progress, joined by a ref callback that pushed
 * the active element into state. That chain never settled. The ref callbacks
 * were inline arrows, so React detached and reattached them on every render,
 * which cleared and reset the element, which tore down and rebuilt the progress
 * effect — and the sequence never advanced.
 *
 * One rAF-batched scroll handler reads every section's box and derives both
 * values, so they cannot disagree and there is no state round-trip.
 */
export function useStoryScroll(count: number): {
  activeIndex: number;
  progress: number;
  register: (index: number) => (el: HTMLElement | null) => void;
} {
  const [state, setState] = useState({ activeIndex: 0, progress: 0 });
  const elements = useRef<(HTMLElement | null)[]>([]);

  // One callback per index, cached, so React attaches each ref once instead of
  // detaching and reattaching on every render — which would briefly null the
  // entry a scroll measurement could land on.
  const callbacks = useRef<Array<(el: HTMLElement | null) => void>>([]);
  const register = useCallback((index: number) => {
    callbacks.current[index] ||= (el: HTMLElement | null) => {
      elements.current[index] = el;
    };
    return callbacks.current[index];
  }, []);

  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const centre = window.innerHeight / 2;

      // Active = whichever section's own centre is nearest the middle of the
      // screen. A distance rather than an intersection test, so exactly one
      // section qualifies however tall they are or how fast the page moves.
      let activeIndex = 0;
      let best = Infinity;
      for (let i = 0; i < elements.current.length; i++) {
        const el = elements.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - centre);
        if (d < best) {
          best = d;
          activeIndex = i;
        }
      }

      const el = elements.current[activeIndex];
      let progress = 0;
      if (el) {
        const r = el.getBoundingClientRect();
        // 0 when the section's top reaches the middle of the screen, 1 when its
        // bottom does — so a sequence advances across exactly the scroll the
        // chapter occupies.
        progress = Math.min(1, Math.max(0, (centre - r.top) / Math.max(1, r.height)));
      }

      setState((prev) =>
        prev.activeIndex === activeIndex && Math.abs(prev.progress - progress) < 0.004
          ? prev
          : { activeIndex, progress },
      );
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [count]);

  return { ...state, register };
}

/**
 * Counts up to `value` once the element has been scrolled into view, then stops.
 * Respects prefers-reduced-motion by jumping straight to the final value.
 */
export function useCountUp(value: number, durationMs = 1200) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLElement | null>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(value);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || done.current) return;
        done.current = true;
        const start = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / durationMs);
          // ease-out cubic: fast start, settles on the number
          setDisplay(value * (1 - Math.pow(1 - t, 3)));
          if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, durationMs]);

  return { ref, display };
}
