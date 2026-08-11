import { CHAPTERS, type ChapterVisual } from './chapters';
import { useState } from 'react';
import { useCountUp, useStoryScroll } from './useInView';
import './story.css';

/** Links are relative so they keep working under the /map-explorer/ Pages base. */
const EXPLORE_URL = './explore.html';

/**
 * Hero background. Drop a file at public/story/hero.webp and it appears; leave
 * it out and the header falls back to flat dark, which is why this is an inline
 * style with a relative URL rather than a CSS url(): a missing file is a 404 at
 * runtime instead of a failed build, and the path survives the Pages base.
 *
 * WebP, ~2560 px wide, under ~300 KB. The whole story page is 64 KB of code —
 * an unoptimised background would dominate the first paint several times over.
 */
const HERO_IMAGE = './story/hero.webp';

function Stat({ value, unit, label, decimals = 0 }: Extract<ChapterVisual, { kind: 'stat' }>) {
  const { ref, display } = useCountUp(value);
  return (
    <div className="story-stat" ref={ref as React.RefObject<HTMLDivElement>}>
      <div className="story-stat__value">
        {display.toLocaleString(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}
        <span className="story-stat__unit">{unit}</span>
      </div>
      <div className="story-stat__label">{label}</div>
    </div>
  );
}

function Sequence({
  visual,
  progress,
}: {
  visual: Extract<ChapterVisual, { kind: 'sequence' }>;
  progress: number;
}) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const usable = visual.frames.filter((f) => !failed[f.src]);

  // Frames are stacked and cross-faded rather than swapped, so the browser has
  // already decoded the next one before it is needed and nothing flashes.
  const index = Math.min(
    visual.frames.length - 1,
    Math.floor(progress * visual.frames.length),
  );
  const active = visual.frames[index];

  if (!usable.length) {
    return (
      <div className="story-placeholder">
        <span>{visual.note}</span>
      </div>
    );
  }

  return (
    <figure className="story-sequence">
      <div className="story-sequence__stack">
        {visual.frames.map((f, i) => (
          <img
            key={f.src}
            src={f.src}
            alt={f.alt}
            loading="eager"
            style={{ opacity: i === index ? 1 : 0 }}
            onError={() => setFailed((prev) => ({ ...prev, [f.src]: true }))}
          />
        ))}
        <ol className="story-sequence__steps" aria-hidden="true">
          {visual.frames.map((f, i) => (
            <li key={f.src} className={i === index ? 'is-active' : undefined} />
          ))}
        </ol>
      </div>
      {active?.caption && <figcaption>{active.caption}</figcaption>}
    </figure>
  );
}

function Visual({ visual, progress = 0 }: { visual: ChapterVisual; progress?: number }) {
  switch (visual.kind) {
    case 'sequence':
      return <Sequence visual={visual} progress={progress} />;
    case 'stat':
      return <Stat {...visual} />;
    case 'image':
    case 'figure':
      return (
        <figure className="story-figure">
          <img src={visual.src} alt={visual.alt} loading="lazy" />
          {visual.caption && <figcaption>{visual.caption}</figcaption>}
        </figure>
      );
    case 'placeholder':
      return (
        <div className="story-placeholder">
          <span>{visual.note}</span>
        </div>
      );
  }
}

export default function Story() {
  // Active chapter and its scroll progress come from one measurement, so the
  // sticky visual and the sequence inside it cannot disagree.
  const { activeIndex, progress, register } = useStoryScroll(CHAPTERS.length);

  return (
    <div className="story">
      <nav className="story-nav" aria-label="Chapters">
        {CHAPTERS.map((c, i) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            className={i === activeIndex ? 'is-active' : undefined}
            aria-current={i === activeIndex ? 'true' : undefined}
          >
            <span className="story-nav__dot" />
            <span className="story-nav__label">{c.title}</span>
          </a>
        ))}
      </nav>

      <header
        className="story-hero"
        style={{ backgroundImage: `url(${HERO_IMAGE})` }}
      >
        {/* Scrim, not a filter on the image: it keeps the text legible whatever
            the photograph turns out to be, and costs nothing when there is
            no image at all. */}
        <div className="story-hero__scrim" aria-hidden="true" />
        <p className="story-hero__eyebrow story-hero__content">Global Vegetation Structure Model</p>
        <h1 className="story-hero__content">The shape of the world's forests</h1>
        <p className="story-hero__lede story-hero__content">
          A 10-metre dataset of of Earth’s vegetation vertical structure
        </p>
        <a className="story-cta story-cta--ghost story-hero__content" href="#010-what-we-mapped">
          Start reading
        </a>
      </header>

      <main className="story-body">
        {/* Sticky visual on the left, prose scrolling past on the right. The
            visual is driven by whichever chapter is crossing the middle of the
            viewport, so the two stay in step without any scroll maths. */}
        <div className="story-sticky" aria-hidden="true">
          <Visual visual={CHAPTERS[activeIndex].visual} progress={progress} />
        </div>

        <div className="story-prose">
          {CHAPTERS.map((chapter, i) => (
            <section
              key={chapter.id}
              id={chapter.id}
              ref={register(i)}
              className="story-chapter"
            >
              {chapter.eyebrow && <p className="story-chapter__eyebrow">{chapter.eyebrow}</p>}
              <h2>{chapter.title}</h2>
              {chapter.body.map((paragraph, j) => (
                <p key={j}>{paragraph}</p>
              ))}

              {/* On narrow screens the sticky column collapses, so each chapter
                  carries its own copy of the visual inline. */}
              <div className="story-chapter__visual">
                <Visual visual={chapter.visual} progress={i === activeIndex ? progress : 0} />
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="story-outro">
        <h2>Explore it yourself</h2>
        <p>
          The map is live, reading the published cloud-optimised GeoTIFFs directly.
        </p>
        <a className="story-cta" href={EXPLORE_URL}>
          Open the map →
        </a>
      </footer>
    </div>
  );
}
