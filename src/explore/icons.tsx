/** Small stroke icons for the explorer's card and cube controls (24 px grid, currentColor). */

type P = { size?: number };

const svg = (size: number, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const ShareIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </>,
  );

export const CloseIcon = ({ size = 16 }: P) => svg(size, <path d="M6 6l12 12M18 6L6 18" />);

export const ResetViewIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 3v6h6" />
    </>,
  );

/** A block seen from a corner: "show the whole block" / slices back to the pin. */
export const BlockIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>,
  );

export const HelpIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 16.8h.01" />
    </>,
  );

/** Three sliders: the cube's further settings. */
export const SlidersIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>,
  );

export const ExpandIcon = ({ size = 16 }: P) => svg(size, <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />);

export const CollapseIcon = ({ size = 16 }: P) => svg(size, <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />);

export const PageDownloadIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9.5 14.5L12 17l2.5-2.5" />
    </>,
  );

export const DownloadIcon = ({ size = 16 }: P) =>
  svg(size, <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />);

export const CheckIcon = ({ size = 16 }: P) => svg(size, <path d="M5 12.5l4.5 4.5L19 7" />);
