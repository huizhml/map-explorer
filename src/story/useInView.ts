import { useEffect, useRef, useState } from 'react';

/**
 * Reports which of a set of sections is currently the "active" one.
 *
 * Scrollytelling needs one active section at a time, not a per-element boolean:
 * during a scroll two sections are usually intersecting at once, and a naive
 * per-element `isIntersecting` flag makes the sticky visual flicker between
 * them. The rootMargin below collapses the viewport to a thin band across the
 * middle, so a section becomes active when it crosses the centre line and
 * exactly one section qualifies at a time.
 *
 * No scrollytelling library needed — IntersectionObserver is the whole
 * mechanism, and it runs off the main thread.
 */
export function useActiveSection(count: number): {
  activeIndex: number;
  register: (index: number) => (el: HTMLElement | null) => void;
} {
  const [activeIndex, setActiveIndex] = useState(0);
  const elements = useRef<(HTMLElement | null)[]>([]);

  const register = (index: number) => (el: HTMLElement | null) => {
    elements.current[index] = el;
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = elements.current.indexOf(entry.target as HTMLElement);
          if (index >= 0) setActiveIndex(index);
        }
      },
      // Top and bottom pulled in to a ~20% band around the middle of the screen.
      { rootMargin: '-40% 0px -40% 0px', threshold: 0 },
    );

    for (const el of elements.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [count]);

  return { activeIndex, register };
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
