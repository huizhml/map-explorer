import { Hero } from '../story/Hero';
import '../story/story.css';

/**
 * The review site's front door: the story's title slide and nothing else.
 *
 * A reviewer arriving cold needs to know what the dataset is before the map
 * means anything, but not to read six chapters to find out — so this is the
 * hero alone, with one way on. The chapters, their figures and the deck's
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
        <Hero actions={<a className="story-cta" href="./explore.html">Explore the map →</a>} />
      </div>
    </div>
  );
}
