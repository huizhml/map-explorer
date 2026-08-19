import { Colorbar, type ColorRamp } from './Colorbar';

export type ExploreLayer = {
  id: string;
  rhIndex: number;
  visible: boolean;
  /** 0-1. Stacked layers hide each other otherwise. */
  opacity: number;
};

/**
 * Layer list, on the map rather than in the sidebar.
 *
 * The sidebar chooses *what* to look at; whether a layer is drawn and how
 * strongly is a property of the map and belongs next to it — which is where the
 * full app puts its layer panel too.
 *
 * Which layers exist is no longer decided here: the sidebar's RH buttons are a
 * multi-select, so adding and removing a layer is toggling its button. A delete
 * control here would be a second, desynchronised way to do the same thing, and
 * pinning meant nothing once changing RH stopped replacing the current layer.
 */
export function LayerControl({
  layers,
  year,
  ramps,
  onToggleVisible,
  onOpacity,
}: {
  layers: ExploreLayer[];
  year: number;
  /** Colour scales for the visible layers, from buildRamps. */
  ramps: ColorRamp[];
  onToggleVisible: (id: string) => void;
  onOpacity: (id: string, value: number) => void;
}) {
  if (!layers.length) return null;

  return (
    <div className="ex-layers">
      <h2 className="ex-layers__head">Layers</h2>
      <ul className="ex-layers__list">
        {layers.map((l) => (
          <li key={l.id}>
            <div className="ex-layers__main">
            <button
              type="button"
              className={`ex-layers__icon${l.visible ? ' is-on' : ''}`}
              onClick={() => onToggleVisible(l.id)}
              title={l.visible ? 'Hide' : 'Show'}
              aria-pressed={l.visible}
            >
              {l.visible ? (
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9Zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M2.4 3.8 3.8 2.4l17.8 17.8-1.4 1.4-3.2-3.2A11 11 0 0 1 12 19C7 19 3 14.5 2 12a13 13 0 0 1 3.7-4.9L2.4 3.8Zm9.6 3.7c2.5 0 4.5 2 4.5 4.5 0 .6-.1 1.1-.3 1.6l-5.8-5.8c.5-.2 1-.3 1.6-.3Z"
                  />
                </svg>
              )}
            </button>

            <span className="ex-layers__name">
              RH{l.rhIndex} · {year}
            </span>
            </div>

            {/* Its own line: a slider squeezed in beside the icon row is too
                short to be usable. */}
            <input
              className="ex-layers__opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={l.opacity}
              disabled={!l.visible}
              onChange={(e) => onOpacity(l.id, Number(e.target.value))}
              title={`Opacity ${Math.round(l.opacity * 100)}%`}
              aria-label={`Opacity of RH${l.rhIndex}`}
            />
          </li>
        ))}
      </ul>

      {/* Inside the card rather than floating on its own: the map's four
          corners are taken, and the scale means nothing without the list of
          layers it applies to. */}
      <Colorbar ramps={ramps} />
    </div>
  );
}
