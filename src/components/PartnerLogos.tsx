import type { CSSProperties } from 'react';
import './partner-logos.css';

/**
 * The institutions and infrastructure behind the dataset, as a logo strip.
 *
 * Shared by the title page and the explore sidebar rather than written twice:
 * the list is the same six either way, and a strip that says one thing on the
 * landing page and another on the map would be a claim about who was involved,
 * not a styling difference.
 *
 * Files live in public/logos/ and are referenced relatively, like HERO_IMAGE —
 * every page of both builds sits at the site root, and a relative path survives
 * the Pages base where an absolute one does not.
 *
 * One web-format file per logo, flattened out of the vendor packages: those ship
 * print formats (.ai, .eps, CMYK, Pantone) that would otherwise be published
 * along with everything else in public/.
 */

/**
 * Colour versions throughout, on a light band — the packages' white variants
 * only exist for some of the six, and mixing white marks with colour ones
 * looked like two strips that happened to be adjacent. `scale` trims the two
 * with seals, which carry more detail per unit of height than a wordmark and
 * read as oversized at a shared height.
 */
const LOGOS = [
  { file: 'ucph.png', alt: 'University of Copenhagen', scale: 1.15 },
  { file: 'rostock.webp', alt: 'Universität Rostock', scale: 1.15 },
  { file: 'pcai.svg', alt: 'Pioneer Centre for AI', scale: 1 },
  { file: 'lumi.png', alt: 'LUMI supercomputer', scale: 0.8 },
  { file: 'cloudferro.svg', alt: 'CloudFerro', scale: 1 },
  { file: 'source-coop.svg', alt: 'Source Cooperative', scale: 1 },
];

/**
 * `hero` is the wide band under the title page's call to action; `panel` is the
 * narrow two-per-row grid in the explore sidebar's foot. Same markup, different
 * height and wrapping — see partner-logos.css.
 */
export function PartnerLogos({ variant }: { variant: 'hero' | 'panel' }) {
  return (
    <ul className={`pl pl--${variant}`}>
      {LOGOS.map((l) => (
        <li key={l.file}>
          {/* `scale` rides in as a custom property rather than a height: the
              CSS caps each logo by height *and* by the width of its slot, and
              a fixed height would override the width cap and let the widest
              marks run out of the sidebar. */}
          <img
            src={`./logos/${l.file}`}
            alt={l.alt}
            style={l.scale === 1 ? undefined : ({ '--pl-scale': l.scale } as CSSProperties)}
            loading="lazy"
          />
        </li>
      ))}
    </ul>
  );
}
