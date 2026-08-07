import { useMemo } from 'react';
import {
  DEFAULT_VSM_VERSION,
  getVsmLayerId,
  type VsmLayerEntry,
  type VsmQChoice,
} from '../constants/predictions';
import './explore.css';

/**
 * The reviewer-facing control surface: pick a layer, toggle it, switch basemap.
 *
 * Deliberately not a slimmed-down copy of Sidebar.tsx. That file is ~3,000 lines
 * of upload / export / saved-feature / auxiliary-layer machinery, none of which
 * works (or should work) on the public read-only backend. What *is* shared is
 * everything below the UI: the layer entry types, LayerManager, the auto-load
 * hook, the store.
 */

// Only the percentiles that have published data. Intervals need Q0/Q2, which
// are not on source.coop yet — offering them would render blank tiles.
const Q_CHOICES: { value: VsmQChoice; label: string }[] = [
  { value: 'median', label: 'Median' },
];

const RH_CHOICES = [98, 95, 90, 75, 50, 25, 10];
const YEARS = [2020] as const;

export type BasemapId = 'osm' | 'satellite' | 'none';

const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'osm', label: 'Map' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'none', label: 'None' },
];

type Props = {
  rhIndex: number;
  onRhIndex: (rh: number) => void;
  year: (typeof YEARS)[number];
  onYear: (y: (typeof YEARS)[number]) => void;
  qChoice: VsmQChoice;
  onQChoice: (q: VsmQChoice) => void;
  visible: boolean;
  onVisible: (v: boolean) => void;
  basemap: BasemapId;
  onBasemap: (b: BasemapId) => void;
};

export function SimpleControls(props: Props) {
  const entry: VsmLayerEntry = useMemo(
    () => ({
      year: props.year,
      rhIndex: props.rhIndex,
      qChoice: props.qChoice,
      version: DEFAULT_VSM_VERSION,
    }),
    [props.year, props.rhIndex, props.qChoice],
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
        <label htmlFor="ex-q">Quantile</label>
        <select
          id="ex-q"
          value={props.qChoice}
          onChange={(e) => props.onQChoice(e.target.value as VsmQChoice)}
        >
          {Q_CHOICES.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
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

      <section className="ex-field">
        <label>Basemap</label>
        <div className="ex-segmented" role="group" aria-label="Basemap">
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={b.id === props.basemap ? 'is-active' : undefined}
              onClick={() => props.onBasemap(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </section>

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
