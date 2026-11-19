import { CitationRef, CopyBibtex } from '../components/Citation';
import { RESOURCE_LINKS } from '../components/resourceLinks';
import { Hero } from '../story/Hero';
import '../story/story.css';


/**
 * The review site's about page: the story's title slide and nothing else.
 *
 * The map is the front door; this is where its footer points anyone who wants
 * to know what the dataset is, without reading six chapters to find out — so
 * it is the hero alone, with one way back. The chapters, their figures and the deck's
 * swipe machinery are all absent from this bundle.
 *
 * The wrappers are the deck's own: `.story-slide` is a flex child sized to the
 * track, so it only fills the screen inside `.story-deck__track`. Reusing the
 * two containers for a single slide is what makes this page lay out identically
 * to the story's first slide without a line of new CSS. The track's transform
 * transition never fires — there is nowhere to slide to.
 */
export default function Landing() {
  return (
    <div className="story story-deck">
      <div className="story-deck__track">
        <Hero
          actions={
            <>
              <a className="story-cta" href={`${import.meta.env.BASE_URL}explorer/`}>
                Explore the map →
              </a>
              {RESOURCE_LINKS.filter((l) => l.href).map((l) => (
                <a
                  key={l.label}
                  className="story-cta story-cta--resource"
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {l.icon}
                  <span>{l.label}</span>
                </a>
              ))}
            </>
          }
          foot={
            <p className="story-hero__cite">
              <CitationRef /> <CopyBibtex className="story-hero__cite-copy" />
            </p>
          }
        />
      </div>
    </div>
  );
}
