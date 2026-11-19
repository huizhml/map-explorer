import { useState } from 'react';
import { BIBTEX, DOI } from './citationData';

/** The reference itself, inline: authors, year, title, venue, DOI link. */
export function CitationRef() {
  return (
    <>
      Zhang, H., Lang, N., Mazurczyk, M., Oehmcke, S., Huang, K., Brandt, M., Fensholt, R., Kariryaa, A., &amp; Igel,
      C. (2026). A vertical vegetation structure model of the Earth. <i>EarthArXiv preprint</i>.{' '}
      <a href={`https://doi.org/${DOI}`} target="_blank" rel="noreferrer">
        doi:{DOI}
      </a>
    </>
  );
}

/** Copies the BibTeX entry; says "Copied" for a moment when it worked. */
export function CopyBibtex({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Clipboard is unavailable on plain http (non-localhost); fail quietly
    // rather than claim a copy that did not happen.
    navigator.clipboard?.writeText(BIBTEX).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? 'Copied' : 'Copy BibTeX'}
    </button>
  );
}
