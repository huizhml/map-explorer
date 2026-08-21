import type { ReactNode } from 'react';
import { PartnerLogos } from '../components/PartnerLogos';

/**
 * The title slide, shared by the story deck and the standalone review landing.
 *
 * It lives apart from Story.tsx because two pages now open with it and the
 * headline is the first thing a reviewer reads — one copy means the two cannot
 * drift into saying different things about the same dataset.
 *
 * What differs between the two is only what you can do next, so the buttons are
 * a prop rather than a `variant` flag: the story offers a way into the deck and
 * a shortcut to the map, the review page offers just the map.
 */

/**
 * Used as the hero headline and as the deck's aria-label, so editing it here
 * keeps what a screen reader announces the same as what is on screen.
 *
 * Separate from the browser tab's <title>, which names the dataset rather than
 * the story.
 */
export const STORY_TITLE = 'A Vertical Vegetation Structure Model of the Earth';

export const HERO_LEDE =
  "A 10-metre dataset of Earth’s vertical vegetation structure for the year 2020, derived from NASA's GEDI LiDAR data and Sentinel-2 imagery.";

/**
 * Hero background. Drop a file at public/story/hero.webp and it appears; leave
 * it out and the title slide falls back to flat dark, which is why this is an
 * inline style with a relative URL rather than a CSS url(): a missing file is a
 * 404 at runtime instead of a failed build, and the path survives the Pages
 * base.
 *
 * WebP, ~2560 px wide, under ~300 KB. The story page is 64 KB of code — an
 * unoptimised background would dominate the first paint several times over.
 */
export const HERO_IMAGE = './story/hero.webp';

export function Hero({ actions, hidden }: { actions: ReactNode; hidden?: boolean }) {
  return (
    <section
      className="story-slide story-slide--hero"
      style={{ backgroundImage: `url(${HERO_IMAGE})` }}
      aria-hidden={hidden}
    >
      {/* Scrim, not a filter on the image: it keeps the text legible whatever
          the photograph turns out to be, and costs nothing when there is no
          image at all. */}
      <div className="story-hero__scrim" aria-hidden="true" />
      <div className="story-hero__content">
        <h1>{STORY_TITLE}</h1>
        <p className="story-hero__lede">{HERO_LEDE}</p>
        <div className="story-hero__actions">{actions}</div>
      </div>

      {/* Outside the content column, along the foot of the slide. A credit line
          is not part of the argument the headline is making, and centring it
          under both halves — text on the left, render on the right — reads as
          belonging to the whole page rather than to the paragraph above it.

          In the story deck the same corners carry the chapter dots (left) and
          the controls (right); the strip is centred and width-capped to stay
          out of both. */}
      <PartnerLogos variant="hero" />
    </section>
  );
}
