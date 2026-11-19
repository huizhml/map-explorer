import { RESOURCE_LINKS } from './resourceLinks';
import './top-bar.css';

/** An open book: the documentation, kept apart from the preprint's page icon. */
const DocsIcon = (
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
    <path d="M12 6.5C10.5 5.3 8.4 4.7 5 4.7v13c3.4 0 5.5.6 7 1.8 1.5-1.2 3.6-1.8 7-1.8v-13c-3.4 0-5.5.6-7 1.8Z" />
    <path d="M12 6.5v13" />
  </svg>
);

/**
 * The bar across the top of the explorer and the docs page: the University
 * of Copenhagen's seal, the dataset's home (the other partners are credited in
 * full in the explorer panel's foot and at the foot of the docs page — six
 * logos at this height would be unreadable and crowd out the links); the
 * dataset's name, which goes back to the landing page; Docs, with its label, since it
 * is the site's own page; and the preprint, data and code as icons — the
 * label is each icon's tooltip and accessible name.
 *
 * `current` marks the page the reader is on (underlined, aria-current).
 */
export function TopBar({ current }: { current?: 'docs' }) {
  const base = import.meta.env.BASE_URL;
  return (
    <header className="tb">
      <a
        className="tb__home"
        href="https://www.ku.dk/"
        target="_blank"
        rel="noreferrer"
        title="University of Copenhagen"
      >
        <img src={`${base}logos/ucph-seal.webp`} alt="University of Copenhagen" width="30" height="30" />
      </a>
      <a className="tb__title" href={base}>
        Vertical Vegetation Structure
      </a>
      <nav className="tb__links" aria-label="Site">
        <a
          className={`tb__docs${current === 'docs' ? ' is-current' : ''}`}
          href={`${base}documentation/`}
          aria-current={current === 'docs' ? 'page' : undefined}
        >
          {DocsIcon}
          <span>Docs</span>
        </a>
        {RESOURCE_LINKS.filter((l) => l.href).map((l) => (
          <a
            key={l.label}
            className="tb__icon"
            href={l.href}
            target="_blank"
            rel="noreferrer"
            title={l.label}
            aria-label={l.label}
          >
            {l.icon}
          </a>
        ))}
      </nav>
    </header>
  );
}
