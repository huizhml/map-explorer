import { CHAPTERS, type ChapterVisual } from './chapters';
import { useActiveSection, useCountUp } from './useInView';
import './story.css';

/** Links are relative so they keep working under the /map-explorer/ Pages base. */
const EXPLORE_URL = './explore.html';

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

function Visual({ visual }: { visual: ChapterVisual }) {
  switch (visual.kind) {
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
  const { activeIndex, register } = useActiveSection(CHAPTERS.length);

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

      <header className="story-hero">
        <p className="story-hero__eyebrow">Global Vegetation Structure Map</p>
        <h1>The shape of the world's forests</h1>
        <p className="story-hero__lede">
          A 10-metre map of vegetation vertical structure, everywhere on land.
        </p>
        <a className="story-cta story-cta--ghost" href="#010-what-we-mapped">
          Start reading
        </a>
      </header>

      <main className="story-body">
        {/* Sticky visual on the left, prose scrolling past on the right. The
            visual is driven by whichever chapter is crossing the middle of the
            viewport, so the two stay in step without any scroll maths. */}
        <div className="story-sticky" aria-hidden="true">
          <Visual visual={CHAPTERS[activeIndex].visual} />
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
                <Visual visual={chapter.visual} />
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
