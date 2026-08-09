# Story assets

`hero.webp` — background for the story's opening screen.

Not committed as a placeholder: the header falls back to flat dark when it is
absent, so the page works without it.

- **WebP** (or JPEG). Not PNG — a full-bleed photograph as PNG runs to several
  megabytes; not PDF — browsers cannot use one as an image.
- ~2560 px wide, under ~300 KB.
- Dark or mid-tone imagery works best: the scrim darkens the lower-left for the
  text, and a bright image fights it.

```bash
cwebp -q 78 -resize 2560 0 source.png -o public/story/hero.webp
```
