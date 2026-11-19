import type { ReactNode } from 'react';

/** 24 px stroke icons in currentColor, inline so the bundles stay tiny. */
const icon = (children: ReactNode) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** A page with a folded corner and text lines. */
const PaperIcon = icon(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </>,
);

/** A stack of disks: the dataset. */
const DataIcon = icon(
  <>
    <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
    <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
    <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
  </>,
);

/** The GitHub mark, filled, so it reads as the repository at a glance. */
const CodeIcon = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

/**
 * Where the dataset is written up and where it came from: on the landing page
 * as labelled buttons beside the way into the map, and in the explorer's top
 * bar as icons. One list, so the two pages never point to different places.
 *
 * A link with an empty URL is not rendered: better no button than one into a
 * 404, so a link can be blanked here without touching the markup.
 */
export const RESOURCE_LINKS: { label: string; href: string; icon: ReactNode }[] = [
  { label: 'Preprint', href: 'https://eartharxiv.org/repository/view/15380/', icon: PaperIcon },
  { label: 'Data', href: 'https://source.coop/geoai-ucph/gvsm', icon: DataIcon },
  { label: 'Code', href: 'https://github.com/huizhml/global-vegetation-structure', icon: CodeIcon },
];
