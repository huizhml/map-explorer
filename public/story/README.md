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

## Chapter 2 sequence

Three frames that cross-fade as the chapter scrolls past — see
`src/story/chapters.ts`, chapter `020-how-it-is-measured`.

| File | Shows |
|---|---|
| `method-1-sentinel2.webp` | Sentinel-2 true colour over a forested area |
| `method-2-gedi.webp` | The same area with GEDI ground tracks on top |
| `method-3-predicted.webp` | The same area, predicted structure everywhere |

Keep the three **framed identically** — same extent, same size. They are
stacked and cross-faded, so any shift between them reads as a jump rather than
a build-up.

4:3 or thereabouts, ~1200 px wide, WebP. The chapter falls back to a text
placeholder while they are missing, so the page works before they exist.
