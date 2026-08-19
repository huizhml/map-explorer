import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The story as a deck: one slide per chapter, moved left and right.
 *
 * Chapters that build in steps (the GEDI figure has six) are part of the same
 * linear sequence rather than a second axis with its own gesture. One swipe
 * always means "the next thing": the next step if the chapter has one left,
 * otherwise the next chapter. Distinguishing the two by how fast or how far the
 * finger moved would make the same gesture do two things, and a reader has no
 * way to find out which without being surprised by the wrong one. Jumping
 * straight to a chapter is a separate, explicit control — the nav rail.
 *
 * A drag is live in both cases. Between chapters it carries the slide with it;
 * within a chapter it scrubs the figure's own animation, so the argument the
 * figure is making moves under the reader's finger either way.
 */

export type Position = { chapter: number; step: number };

/** How far a drag must get before letting go commits it. */
const COMMIT_FRACTION = 0.12;
/** …or how fast it has to be travelling, in px/ms, however short it was. */
const COMMIT_VELOCITY = 0.45;
/** Wheel notches add up to this before the deck moves, so one flick is one move. */
const WHEEL_THRESHOLD = 90;
const WHEEL_COOLDOWN_MS = 420;

export function useDeck(stepCounts: number[], initialChapter = 0) {
  // Seeded rather than corrected in an effect: a deep link should open on its
  // chapter, not slide there from the title on arrival.
  const [pos, setPos] = useState<Position>(() => ({ chapter: initialChapter, step: 0 }));
  /** Live drag: `carry` moves the slide, `scrub` advances the figure. */
  const [drag, setDrag] = useState({ carry: 0, scrub: 0, active: false });

  const counts = useRef(stepCounts);
  counts.current = stepCounts;
  const posRef = useRef(pos);
  posRef.current = pos;

  const go = useCallback((dir: number) => {
    setPos((p) => {
      const last = counts.current[p.chapter] - 1;
      if (dir > 0) {
        if (p.step < last) return { ...p, step: p.step + 1 };
        if (p.chapter < counts.current.length - 1) return { chapter: p.chapter + 1, step: 0 };
        return p;
      }
      if (p.step > 0) return { ...p, step: p.step - 1 };
      if (p.chapter > 0) {
        const c = p.chapter - 1;
        // Backwards into a built-up chapter lands on its finished state, which
        // is what the reader saw when they left it.
        return { chapter: c, step: counts.current[c] - 1 };
      }
      return p;
    });
  }, []);

  const jump = useCallback((chapter: number) => {
    setPos({ chapter, step: 0 });
  }, []);

  /** Whether dragging in this direction leaves the chapter rather than stepping. */
  const leaves = useCallback((dir: number) => {
    const p = posRef.current;
    return dir > 0 ? p.step >= counts.current[p.chapter] - 1 : p.step <= 0;
  }, []);

  const atEdge = useCallback((dir: number) => {
    const p = posRef.current;
    return dir > 0
      ? p.chapter >= counts.current.length - 1
      : p.chapter <= 0;
  }, []);

  // --- pointer and touch --------------------------------------------------
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = surface.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let startAt = 0;
    let tracking = false;
    let horizontal: boolean | null = null;
    let down = false;

    const width = () => el.clientWidth || 1;

    const begin = (x: number, y: number) => {
      startX = x;
      startY = y;
      startAt = performance.now();
      tracking = true;
      horizontal = null;
    };

    /** Returns true if the gesture is ours and the browser should keep out. */
    const move = (x: number, y: number) => {
      if (!tracking) return false;
      const dx = x - startX;
      const dy = y - startY;
      // Wait for the gesture to declare itself: a mostly-vertical drag is the
      // reader scrolling a long slide on a phone, and stealing it would trap
      // them there.
      if (horizontal === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return false;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) {
          tracking = false;
          return false;
        }
      }
      const dir = dx < 0 ? 1 : -1;
      if (leaves(dir)) {
        // Rubber band at the two ends, so the deck reads as bounded rather than
        // broken when there is nothing further to go to.
        setDrag({ carry: atEdge(dir) ? dx * 0.32 : dx, scrub: 0, active: true });
      } else {
        setDrag({ carry: 0, scrub: Math.max(-1, Math.min(1, -dx / width())), active: true });
      }
      return true;
    };

    /** Put everything back, committed or not. Every exit runs through here. */
    const cancel = () => {
      tracking = false;
      down = false;
      setDrag({ carry: 0, scrub: 0, active: false });
    };

    const end = (x: number) => {
      const ours = tracking && horizontal === true;
      cancel();
      if (!ours) return;
      const dx = x - startX;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - startAt);
      if (Math.abs(dx) > width() * COMMIT_FRACTION || speed > COMMIT_VELOCITY) {
        go(dx < 0 ? 1 : -1);
      }
    };

    const onTouchStart = (e: TouchEvent) => begin(e.touches[0].clientX, e.touches[0].clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (move(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => end(e.changedTouches[0].clientX);

    const onPointerDown = (e: PointerEvent) => {
      // Touch is handled above; links and buttons keep their clicks.
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if ((e.target as HTMLElement).closest('a, button')) return;
      down = true;
      begin(e.clientX, e.clientY);
      // Keep receiving moves even if the pointer leaves the element.
      if (e.pointerId !== undefined) el.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!down) return;
      // A release the page never heard about — the button is already up, so the
      // drag is over and its offset must not be left on the track.
      if (e.buttons === 0) {
        end(e.clientX);
        return;
      }
      move(e.clientX, e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!down) return;
      end(e.clientX);
    };

    // Dragging over an image or a run of text hands the gesture to the
    // browser's own drag-and-drop, which fires pointercancel and then stops
    // sending moves and ups. Without this the slide stayed wherever the finger
    // left it, half way between two chapters, with no way back.
    const onCancel = () => cancel();
    const onDragStart = (e: Event) => e.preventDefault();

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('dragstart', onDragStart);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('blur', onCancel);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onCancel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('blur', onCancel);
    };
  }, [atEdge, go, leaves]);

  // --- wheel and keyboard -------------------------------------------------
  useEffect(() => {
    let acc = 0;
    let last = 0;

    const onWheel = (e: WheelEvent) => {
      // A trackpad swipes sideways; a mouse only has deltaY, and on a page with
      // no vertical scroll left to do, that wheel should still move the story.
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const now = performance.now();
      if (now - last < WHEEL_COOLDOWN_MS) return;
      acc = Math.sign(d) === Math.sign(acc) ? acc + d : d;
      if (Math.abs(acc) < WHEEL_THRESHOLD) return;
      acc = 0;
      last = now;
      go(d > 0 ? 1 : -1);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const forward = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar'];
      const back = ['ArrowLeft', 'ArrowUp', 'PageUp'];
      if (forward.includes(e.key)) {
        e.preventDefault();
        go(1);
      } else if (back.includes(e.key)) {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'Home') {
        setPos({ chapter: 0, step: 0 });
      } else if (e.key === 'End') {
        setPos({ chapter: counts.current.length - 1, step: 0 });
      }
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [go]);

  return { pos, drag, go, jump, setPos, surface };
}
