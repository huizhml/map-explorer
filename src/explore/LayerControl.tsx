import type { VsmQChoice } from '../constants/predictions';

/**
 * Layer visibility, on the map rather than in the sidebar.
 *
 * The sidebar is for choosing *what* to look at; whether it is currently drawn
 * is a property of the map, and belongs next to it — which is also where the
 * full app puts its layer panel.
 */
export function LayerControl({
  rhIndex,
  year,
  qChoice,
  visible,
  onVisible,
}: {
  rhIndex: number;
  year: number;
  qChoice: VsmQChoice;
  visible: boolean;
  onVisible: (v: boolean) => void;
}) {
  return (
    <div className="ex-layers">
      <h2 className="ex-layers__head">Layers</h2>
      <button
        type="button"
        className="ex-layers__row"
        onClick={() => onVisible(!visible)}
        aria-pressed={visible}
      >
        <span className={`ex-layers__eye${visible ? ' is-on' : ''}`} aria-hidden="true">
          {visible ? (
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path
                fill="currentColor"
                d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9Zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path
                fill="currentColor"
                d="M2.4 3.8 3.8 2.4l17.8 17.8-1.4 1.4-3.2-3.2A11 11 0 0 1 12 19C7 19 3 14.5 2 12a13 13 0 0 1 3.7-4.9L2.4 3.8Zm9.6 3.7c2.5 0 4.5 2 4.5 4.5 0 .6-.1 1.1-.3 1.6l-5.8-5.8c.5-.2 1-.3 1.6-.3Zm0-2.5c5 0 9 4.5 10 7a13 13 0 0 1-2.6 3.8l-1.5-1.5A11 11 0 0 0 19.6 12C18.6 10 15.6 7 12 7c-.5 0-1 0-1.4.1L9 5.4c1-.3 2-.4 3-.4Z"
              />
            </svg>
          )}
        </span>
        <span className="ex-layers__name">
          RH{rhIndex} · {qChoice === 'median' ? 'median' : qChoice} · {year}
        </span>
      </button>
    </div>
  );
}
