/**
 * A path under public/ (as chapters.ts and the figure JSON write them, e.g.
 * 'story/pair-a-00.webp') → a URL against the site base. Page-relative would
 * resolve from /vsm/story/ to /vsm/story/story/…; full URLs pass through.
 */
export function publicUrl(path: string): string {
  return /^([a-z]+:|\/)/i.test(path) ? path : `${import.meta.env.BASE_URL}${path}`;
}
