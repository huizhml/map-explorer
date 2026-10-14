/**
 * Pixel size of the tiles the app asks TiTiler for (its `tilesize=` parameter).
 *
 * 512 rather than the usual 256: a view needs a quarter as many requests for the
 * same resolution. The browser opens only six connections to the backend, and
 * the rest queue behind them, so request count — not bytes — is what made the
 * map fill in slowly.
 *
 * With 512 px tiles MapLibre's tile zoom is the map zoom (with 256 px tiles it
 * is one more), so source zoom ranges below are given in map zoom levels.
 */
export const TILE_SIZE = 512;

/** The query parameter that goes with it, for TiTiler tile URLs. */
export const TILE_SIZE_PARAM = `tilesize=${TILE_SIZE}`;
