import { useMemo } from 'react';
import {
  DEFAULT_VSM_VERSION,
  getVsmLayerId,
  type VsmLayerEntry,
  type VsmQChoice,
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
  rhIndex: number;
  onRhIndex: (rh: number) => void;
  year: (typeof YEARS)[number];
  onYear: (y: (typeof YEARS)[number]) => void;
  visible: boolean;
  onVisible: (v: boolean) => void;
};

export function SimpleControls(props: Props) {
  const entry: VsmLayerEntry = useMemo(
    () => ({
      year: props.year,
      rhIndex: props.rhIndex,
      qChoice: 'median',
      version: DEFAULT_VSM_VERSION,
    }),
    [props.year, props.rhIndex],
  );

  return (
    <aside className="ex-panel">
      <header className="ex-panel__head">
        <h1>Vegetation Structure</h1>
        <p>Global canopy structure at 10 m, 2020.</p>
      </header>

      <section className="ex-field">
        <label htmlFor="ex-rh">
          Relative height
          <span className="ex-hint">
            RH{props.rhIndex} — height below which {props.rhIndex}% of returned energy falls
          </span>
        </label>
        <select
          id="ex-rh"
          value={props.rhIndex}
          onChange={(e) => props.onRhIndex(Number(e.target.value))}
        >
          {RH_CHOICES.map((rh) => (
            <option key={rh} value={rh}>
              RH{rh}
              {rh === 98 ? ' (canopy top)' : ''}
            </option>
          ))}
        </select>
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

      <section className="ex-field ex-field--row">
        <label htmlFor="ex-visible">Show layer</label>
        <input
          id="ex-visible"
          type="checkbox"
          checked={props.visible}
          onChange={(e) => props.onVisible(e.target.checked)}
        />
      </section>

      {/* Basemap lives on the map itself, bottom-right — see SimpleApp. */}

      <p className="ex-tip">Click the map to read the profile at that point.</p>

      <footer className="ex-panel__foot">
        <span className="ex-layer-id" title={getVsmLayerId(entry)}>
          {getVsmLayerId(entry)}
        </span>
        <a href="./index.html">← Story</a>
      </footer>
    </aside>
  );
}
