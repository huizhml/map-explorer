import { PartnerLogos } from '../components/PartnerLogos';
import { DownloadPanel } from './DownloadPanel';
import './explore.css';

/**
 * The reviewer-facing control surface: pick a layer and toggle it. The basemap
 * switch lives on the map itself (SimpleApp), bottom-right.
 *
 * Deliberately not a slimmed-down copy of Sidebar.tsx. That file is ~3,000 lines
 * of upload / export / saved-feature / auxiliary-layer machinery, none of which
 * works (or should work) on the public read-only backend. What *is* shared is
 * everything below the UI: the layer entry types, LayerManager, the auto-load
 * hook, the store.
 */

// The published data is the median quantile only — Q0/Q2 are not on
// source.coop — so there is nothing to choose between and no control for it.
// SimpleApp still passes qChoice through, since the layer id is built from it.

const RH_CHOICES = [98, 95, 90, 75, 50, 25, 10];
const YEARS = [2020] as const;

export type BasemapId = 'osm' | 'satellite' | 'none';

export const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'osm', label: 'Map' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'none', label: 'None' },
];

type Props = {
  /** Every RH currently on the map. Order is irrelevant here. */
  rhIndexes: number[];
  onToggleRh: (rh: number) => void;
  year: (typeof YEARS)[number];
  onYear: (y: (typeof YEARS)[number]) => void;
};

export function SimpleControls(props: Props) {
  const { rhIndexes } = props;

  return (
    <aside className="ex-panel">
      <header className="ex-panel__head">
        <h1>Vertical Vegetation Structure</h1>
        <p>A 10-metre dataset of Earth's vertical vegetation structure, derived from NASA's GEDI LiDAR data and Sentinel-2 imagery.</p>
      </header>

      {/* Ahead of the controls, since it explains what they are for. Numbered
          rather than bulleted: this is the order the page is meant to be used
          in, not a list of unrelated features. */}
      <section className="ex-intro">
        <h2>Introduction</h2>
        <ol>
          <li>Select different relative height (RH) maps to visualize.</li>
          <li>Zoom into a local area to load high-resolution data.</li>
          <li>Click “Visit a random site” to check precomputed vertical profiles.</li>
          <li>Click on the map to visualize the full vertical profile at that location.</li>
        </ol>
      </section>

      {/* Buttons rather than a <select>: seven choices all visible at once, and
          a multi-select, so several RHs can be stacked and compared. Each is a
          checkbox, not a radio — turning one off is what removes its layer.
          RH98 is on by default, set by SimpleApp's initial layer. */}
      <section className="ex-field">
        <span className="ex-field__label" id="ex-rh-label">
          Relative height
          <span className="ex-hint">
            RH<i>n</i> — height below which <i>n</i>% of returned energy falls.
          </span>
        </span>
        <div className="ex-choices" role="group" aria-labelledby="ex-rh-label">
          {RH_CHOICES.map((rh) => {
            const on = rhIndexes.includes(rh);
            return (
              <button
                key={rh}
                type="button"
                role="checkbox"
                aria-checked={on}
                className={on ? 'ex-choice is-active' : 'ex-choice'}
                onClick={() => props.onToggleRh(rh)}
                title={rh === 98 ? 'Canopy top' : undefined}
              >
                RH{rh}
              </button>
            );
          })}
        </div>
        {rhIndexes.length === 0 && (
          <span className="ex-hint">No layer selected — the map shows the basemap only.</span>
        )}
      </section>

      <section className="ex-field">
        <label htmlFor="ex-year">Year</label>
        <select
          id="ex-year"
          value={props.year}
          onChange={(e) => props.onYear(Number(e.target.value) as (typeof YEARS)[number])}
        >
          {YEARS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        {/* A one-entry dropdown otherwise reads as a broken control. This says
            it is a control with one value so far, not a control that failed. */}
        <span className="ex-hint">More years in preparation.</span>
      </section>

      {/* A button here, a flyout over the map. Under the controls that seed it
          — the download defaults to the RH levels on screen and the tiles under
          the view — but out of the column, because the panel it opens is taller
          than everything above it put together. */}
      <DownloadPanel rhIndexes={rhIndexes} year={props.year} />

      {/* After the controls, not before: these are caveats about what you get
          once you have used them, and read as warnings-not-to-bother if they
          come first. */}
      <section className="ex-notes">
        <h2>Please note</h2>
        <ul>
          <li>
            The satellite basemap is not from the same date as the VSM data — imagery and
            predictions can disagree where the ground has changed since 2020.
          </li>
          <li>
            Loading can be slow: it depends on how much of the world is in view and on how
            many people are using the site at once.
          </li>
          {/* Sits with the caveats rather than in the foot: what you may do
              with the data is a condition of using it, and the foot is a place
              readers skip. Named with a link, since "CC BY 4.0" alone asks the
              reader to already know what that permits. */}
          <li>
            The data are released under{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            {' '}— free to use and adapt, including commercially, with attribution.
          </li>
        </ul>
      </section>

      {/* The layer id that used to head this block — vsm_2020_rh98_median_v1
          and the like — is gone. It was internal bookkeeping printed at a
          reviewer, who has the RH buttons above and the layer list on the map
          to tell them what is loaded.

          Holding the logos too, so the two travel to the bottom of the panel
          together: the foot is what carries `margin-top: auto`. */}
      <footer className="ex-panel__foot">
        {/* './index.html' is the way back — the review site's title page, or
            the story deck when it is published. While the story is unpublished
            there is no such page on the main site, so there is no link either:
            better nothing than a link into a 404. */}
        {__REVIEW__ ? (
          <a href="./index.html">← Back</a>
        ) : (
          __STORY__ && <a href="./index.html">← Story</a>
        )}

        <PartnerLogos variant="panel" />
      </footer>
    </aside>
  );
}
