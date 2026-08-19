import { useEffect, useState } from 'react';
import { CHAPTERS, type Chapter, type ChapterVisual } from './chapters';
import { Hero, STORY_TITLE } from './Hero';
import ForestPair from './ForestPair';
import GediShot, { GEDI_STEPS } from './GediShot';
import { useCountUp } from './useInView';
import { useDeck } from './useDeck';
import './story.css';

/** Links are relative so they keep working under the /map-explorer/ Pages base. */
const EXPLORE_URL = './explore.html';

/** `**like this**` in a chapter's prose comes out bold. */
function emphasise(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 ? <strong key={i}>{part}</strong> : part,
  );
}

type Slide = { kind: 'hero' } | { kind: 'chapter'; chapter: Chapter };

const SLIDES: Slide[] = [
  { kind: 'hero' },
  ...CHAPTERS.map((chapter) => ({ kind: 'chapter' as const, chapter })),
];

/**
 * How many swipes each slide is worth. Figures that build in steps declare it;
 * everything else is one moment, so the deck's sequence stays mostly one slide
 * per move and the reader never has to guess which kind of slide they are on.
 */
const STEPS_BY_VISUAL: Partial<Record<ChapterVisual['kind'], number>> = {
  'gedi-shot': GEDI_STEPS,
};
const STEP_COUNTS = SLIDES.map((s) =>
  s.kind === 'chapter' ? (STEPS_BY_VISUAL[s.chapter.visual.kind] ?? 1) : 1,
);
const TOTAL_MOMENTS = STEP_COUNTS.reduce((a, b) => a + b, 0);

function Stat({
  value,
  unit,
  label,
  decimals = 0,
  active,
}: Extract<ChapterVisual, { kind: 'stat' }> & { active: boolean }) {
  const display = useCountUp(value, active);
  return (
    <div className="story-stat">
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

function Visual({
  visual,
  step,
  scrub,
  active,
}: {
  visual: ChapterVisual;
  step: number;
  scrub: number;
  active: boolean;
}) {
  switch (visual.kind) {
    case 'gedi-shot':
      return <GediShot step={step} scrub={active ? scrub : 0} />;
    case 'forest-pair':
      // Plays itself; it only needs to know when it is on screen.
      return <ForestPair active={active} />;
    case 'stat':
      return <Stat {...visual} active={active} />;
    case 'cta':
      return (
        <div className="story-cta-block">
          <p>The map is live, reading the published cloud-optimised GeoTIFFs directly.</p>
          <a className="story-cta" href={EXPLORE_URL}>
            Open the map →
          </a>
        </div>
      );
    case 'video':
      return (
        <figure className="story-figure">
          {/* muted + playsInline are what make autoplay permitted at all; the
              poster covers the gap before it loads and the case where it never
              plays. The clip is a ping-pong, so looping has no visible cut. */}
          <video autoPlay muted loop playsInline poster={visual.poster} aria-label={visual.alt}>
            {visual.sources.map((src) => (
              <source
                key={src}
                src={src}
                type={src.endsWith('.webm') ? 'video/webm' : 'video/mp4'}
              />
            ))}
          </video>
          {visual.caption && <figcaption>{visual.caption}</figcaption>}
        </figure>
      );
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

/** Which slide a URL fragment names, or the title slide. */
function chapterFromHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  const i = SLIDES.findIndex((s) => s.kind === 'chapter' && s.chapter.id === id);
  return i > 0 ? i : 0;
}

export default function Story() {
  // Read once, before the first paint, so a deep link opens on its chapter
  // instead of animating over from the title.
  const [initial] = useState(chapterFromHash);
  const { pos, drag, go, jump, setPos, surface } = useDeck(STEP_COUNTS, initial);

  // Deep links keep working in both directions: editing the fragment moves the
  // deck, and moving the deck rewrites the fragment without adding history
  // entries — the back button should leave the story, not walk back through it
  // one swipe at a time.
  useEffect(() => {
    const onHash = () => setPos({ chapter: chapterFromHash(), step: 0 });
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [setPos]);

  useEffect(() => {
    const slide = SLIDES[pos.chapter];
    const url =
      slide.kind === 'chapter'
        ? `#${slide.chapter.id}`
        : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }, [pos.chapter]);

  const moment = STEP_COUNTS.slice(0, pos.chapter).reduce((a, b) => a + b, 0) + pos.step;
  const first = pos.chapter === 0 && pos.step === 0;
  const last = pos.chapter === SLIDES.length - 1 && pos.step === STEP_COUNTS[pos.chapter] - 1;

  return (
    <div
      className="story story-deck"
      ref={surface}
      aria-roledescription="carousel"
      aria-label={STORY_TITLE}
    >
      <nav className="story-nav" aria-label="Chapters">
        {SLIDES.map((slide, i) => (
          <button
            key={slide.kind === 'chapter' ? slide.chapter.id : 'hero'}
            type="button"
            className={i === pos.chapter ? 'is-active' : undefined}
            aria-current={i === pos.chapter ? 'true' : undefined}
            onClick={() => jump(i)}
          >
            <span className="story-nav__dot" />
            <span className="story-nav__label">
              {slide.kind === 'chapter' ? slide.chapter.title : 'Start'}
            </span>
          </button>
        ))}
      </nav>

      <div
        className="story-deck__track"
        style={{
          transform: `translate3d(calc(${-pos.chapter * 100}% + ${drag.carry}px), 0, 0)`,
          transition: drag.active ? 'none' : undefined,
        }}
      >
        {SLIDES.map((slide, i) => {
          const active = i === pos.chapter;
          if (slide.kind === 'hero') {
            return (
              <Hero
                key="hero"
                hidden={!active}
                /* Two ways in from the title slide. The story ends on a link to
                   the map, but a reader who came for the data should not have
                   to swipe through the whole deck to reach it. */
                actions={
                  <>
                    <button
                      type="button"
                      className="story-cta story-cta--ghost"
                      onClick={() => go(1)}
                    >
                      Start reading →
                    </button>
                    <a className="story-cta" href={EXPLORE_URL}>
                      Explore the map →
                    </a>
                  </>
                }
              />
            );
          }

          const { chapter } = slide;
          return (
            <section
              key={chapter.id}
              id={chapter.id}
              className="story-slide story-slide--chapter"
              aria-hidden={!active}
            >
              {/* Full bleed: the figure is the page, and the prose sits on it.
                  Boxing the figure into a column made every chapter read as a
                  slide in a deck rather than as a place. */}
              <div className="story-slide__visual">
                <Visual
                  visual={chapter.visual}
                  step={active ? pos.step : 0}
                  scrub={drag.scrub}
                  active={active}
                />
              </div>
              <div className="story-slide__scrim" aria-hidden="true" />
              <div className="story-slide__prose">
                {chapter.eyebrow && <p className="story-chapter__eyebrow">{chapter.eyebrow}</p>}
                <h2>{chapter.title}</h2>
                {chapter.body.map((paragraph, j) => (
                  <p key={j}>{emphasise(paragraph)}</p>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* Real buttons, not decoration: with the page no longer scrolling there
          has to be something visible to press, and something for a keyboard to
          reach. */}
      <div className="story-controls">
        <button
          type="button"
          className="story-back"
          onClick={() => go(-1)}
          disabled={first}
          aria-label="Previous"
        >
          ←
        </button>
        <button
          type="button"
          className="story-next"
          onClick={() => go(1)}
          disabled={last}
          aria-label="Next"
        >
          →
        </button>
      </div>

      <div className="story-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${(moment + 1) / TOTAL_MOMENTS})` }} />
      </div>
    </div>
  );
}
