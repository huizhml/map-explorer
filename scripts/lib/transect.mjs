/**
 * Render a transect figure from a line, against a running backend.
 *
 * Two calls, and the join between them is the part that is easy to get wrong:
 * /predictions/vertical-profile-line returns the profile curves in a top-level
 * `vertical_profile` array indexed by sample, while /transect/figure wants them
 * merged into each sample as `profile`. Miss that and the figure renders with
 * an empty heatmap panel and no error — the same join useMapInteractions.ts
 * does for the live app.
 *
 * Shared by scripts/generate-transect-examples.mjs and scripts/publish-sites.mjs
 * precisely so that join exists in one place.
 */

async function postJSON(api, path, body, timeoutMs = 600_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`${path} → HTTP ${resp.status}: ${(await resp.text()).slice(0, 240)}`);
    }
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} api          backend base URL, no trailing slash
 * @param {[number, number][]} line  lon/lat vertices
 * @param {object} [opts]
 * @returns {Promise<{png: Buffer, sampleCount: number, seconds: number}>}
 */
export async function renderTransect(api, line, opts = {}) {
  const {
    year = 2020,
    version = 'original',
    qIndex = 1,
    xAxis,
    dpi = 150,
    onProgress = () => {},
  } = opts;

  const started = Date.now();

  onProgress('sampling');
  const sampled = await (
    await postJSON(api, '/predictions/vertical-profile-line', {
      line_coordinates: line,
      year,
      version,
      q_index: qIndex,
    })
  ).json();
  if (sampled.success === false) throw new Error(sampled.error || 'profile failed');

  const matrix = sampled.vertical_profile ?? [];
  const raw = sampled.samples ?? [];
  if (!raw.length) throw new Error('profile returned no samples');

  const samples = raw.map((s) => ({
    lon: s.lon,
    lat: s.lat,
    distance_m: s.distance_m,
    profile: (matrix[s.index] ?? []).map((value, rh) => ({ rh, value, missing: value == null })),
    fhd: s.fhd ?? null,
    enl1d: s.enl1d ?? null,
    enl2d: s.enl2d ?? null,
    cr: s.cr ?? null,
  }));

  const withProfile = samples.filter((s) => s.profile.some((p) => p.value != null)).length;
  if (withProfile === 0) {
    throw new Error('every sample profile is empty — no prediction data along this line?');
  }

  // Whichever axis actually varies; a line drawn due east has constant latitude,
  // and plotting against it collapses the figure.
  const lons = line.map((p) => p[0]);
  const lats = line.map((p) => p[1]);
  const axis =
    xAxis ??
    (Math.abs(Math.max(...lons) - Math.min(...lons)) >= Math.abs(Math.max(...lats) - Math.min(...lats))
      ? 'lon'
      : 'lat');

  onProgress('rendering');
  const figure = await postJSON(api, '/transect/figure', {
    samples,
    x_axis: axis,
    include_map: true,
    include_heatmap: true,
    // The per-panel provenance badges collide with the colourbar at this width.
    show_panel_labels: false,
    dpi,
    fmt: 'png',
  });

  return {
    png: Buffer.from(await figure.arrayBuffer()),
    sampleCount: samples.length,
    seconds: (Date.now() - started) / 1000,
  };
}
