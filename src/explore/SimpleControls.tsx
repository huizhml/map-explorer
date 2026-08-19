import { useMemo } from 'react';
import {
  DEFAULT_VSM_VERSION,
  getVsmLayerId,
  type VsmLayerEntry,
} from '../constants/predictions';
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
  const { rhIndexes, year } = props;

  // One id per selected RH, highest first — the footer shows the single id when
  // there is one and a count otherwise, with the full list on hover.
  const layerIds = useMemo(
    () =>
      [...rhIndexes]
        .sort((a, b) => b - a)
        .map((rhIndex) => {
          const entry: VsmLayerEntry = {
            year,
            rhIndex,
            qChoice: 'median',
            version: DEFAULT_VSM_VERSION,
          };
          return getVsmLayerId(entry);
        }),
    [rhIndexes, year],
  );

  return (
    <aside className="ex-panel">
      <header className="ex-panel__head">
        <h1>Vertical Vegetation Structure</h1>
        <p>Global canopy structure at 10 m, 2020.</p>
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
      </section>

      <footer className="ex-panel__foot">
        <span className="ex-layer-id" title={layerIds.join('\n')}>
          {layerIds.length === 1 ? layerIds[0] : `${layerIds.length} layers`}
        </span>
        {/* './index.html' is the way back — the review site's title page, or
            the story deck when it is published. While the story is unpublished
            there is no such page on the main site, so there is no link either:
            better nothing than a link into a 404. */}
        {__REVIEW__ ? (
          <a href="./index.html">← Back</a>
        ) : (
          __STORY__ && <a href="./index.html">← Story</a>
        )}
      </footer>
    </aside>
  );
}
