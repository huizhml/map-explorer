export type ExploreLayer = {
  id: string;
  rhIndex: number;
  year: number;
  visible: boolean;
  /** Pinned layers survive a change of RH — a new layer is added instead. */
  pinned: boolean;
};

/**
 * Layer list, on the map rather than in the sidebar.
 *
 * The sidebar chooses *what* to look at; whether a layer is drawn, kept, or
 * removed is a property of the map and belongs next to it — which is where the
 * full app puts its layer panel too.
 */
export function LayerControl({
  layers,
  activeId,
  onToggleVisible,
  onTogglePinned,
  onRemove,
}: {
  layers: ExploreLayer[];
  activeId: string | null;
  onToggleVisible: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!layers.length) return null;

  return (
    <div className="ex-layers">
      <h2 className="ex-layers__head">Layers</h2>
      <ul className="ex-layers__list">
        {layers.map((l) => (
          <li key={l.id} className={l.id === activeId ? 'is-active' : undefined}>
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
              RH{l.rhIndex} · {l.year}
            </span>

            <button
              type="button"
              className={`ex-layers__icon${l.pinned ? ' is-pinned' : ''}`}
              onClick={() => onTogglePinned(l.id)}
              title={l.pinned ? 'Unpin — changing RH will replace this layer' : 'Pin — keep this layer when RH changes'}
              aria-pressed={l.pinned}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M14 2 9.6 6.4l-4 .8a1 1 0 0 0-.5 1.7l3 3-5.4 7.9a.5.5 0 0 0 .7.7l7.9-5.4 3 3a1 1 0 0 0 1.7-.5l.8-4L21 9.9 14 2Z"
                />
              </svg>
            </button>

            <button
              type="button"
              className="ex-layers__icon ex-layers__icon--danger"
              onClick={() => onRemove(l.id)}
              title="Remove layer"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 12H7L6 9Z"
                />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
