import { Hero } from '../story/Hero';
import '../story/story.css';

/**
 * Where the dataset is written up and where it came from, offered beside the map.
 *
 * A link with an empty URL is not rendered: better no button than one into a
 * 404, so a link can be blanked here without touching the markup.
 */
const LINKS: { label: string; href: string }[] = [
  { label: 'Preprint', href: 'https://eartharxiv.org/repository/view/15380/' },
  { label: 'Data', href: 'https://source.coop/geoai-ucph/gvsm' },
  { label: 'Code', href: 'https://github.com/huizhml/global-vegetation-structure' },
];

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
              {LINKS.filter((l) => l.href).map((l) => (
                <a
                  key={l.label}
                  className="story-cta story-cta--ghost"
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {l.label}
                </a>
              ))}
            </>
          }
        />
      </div>
    </div>
  );
}
