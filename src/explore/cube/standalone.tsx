/* eslint-disable react-refresh/only-export-components -- an entry script bundled on its own, never hot-reloaded */
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CubePanel from './CubePanel';
import type { Snapshot } from './CubeScene';
import type { Cube } from './cubeData';
import { columnRh, pixelCentre, profileAt } from './cubeProfile';
import type { Ground, GroundSource } from './groundImagery';
import { gunzipBase64, type PageSnapshot } from './pageSnapshot';
import { ProfileMetrics, RhProfileChart, VerticalProfileChart } from '../ProfileCharts';

/**
 * The saved page's viewer: the explorer's cube card without the map or the
 * backend. Bundled into one script by the `cube-viewer-bundle` plugin in
 * vite.config.ts and inlined into every page exportPage.ts writes.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

function Page({ s }: { s: PageSnapshot }) {
  const [cube, setCube] = useState<Cube | null>(null);
  const [error, setError] = useState<string>();
  const [preloaded, setPreloaded] = useState<Partial<Record<GroundSource, Ground>>>({});
  const [ground, setGround] = useState<GroundSource>(s.groundChoice ?? 'off');
  const [yMaxText, setYMaxText] = useState(String(s.ymax));
  const [, setSnap] = useState<Snapshot | null>(null);
  const yMax = Number(yMaxText) > 0 ? Number(yMaxText) : 50;

  useEffect(() => {
    // The ground images first, so the cube's first frame already stands on one.
    const imgs = Promise.all(
      (s.grounds ?? []).map((g) =>
        loadImage(g.image).then((image): [GroundSource, Ground] => [
          g.source,
          { image, credit: g.credit, note: g.note, date: g.date },
        ]),
      ),
    );
    Promise.all([gunzipBase64(s.raw), imgs])
      .then(([buf, loaded]) => {
        setPreloaded(Object.fromEntries(loaded));
        const levels = s.meta.rh_last - s.meta.rh_first + 1;
        setCube({ meta: s.meta, raw: new Int16Array(buf, 0, levels * s.meta.size * s.meta.size) });
      })
      .catch((e) => setError(String(e)));
  }, [s]);

  // The pin can be moved on the overview images: no map here, but the same pixels.
  const [probe, setProbe] = useState(s.probe);
  const pixel = probe ?? s.meta.click;
  const [pinLon, pinLat] = probe ? pixelCentre(s.meta, probe.row, probe.col) : [s.lon, s.lat];
  const profile = useMemo(() => (cube ? profileAt(cube, pixel.row, pixel.col) : null), [cube, pixel.row, pixel.col]);
  const rows = useMemo(() => {
    if (!cube) return [];
    const rhs = columnRh(cube, pixel.row, pixel.col);
    return [...s.rhIndexes]
      .sort((a, b) => b - a)
      .map((rh) => (rhs[rh] === null ? `RH${rh} · no data` : `RH${rh} · ${rhs[rh]!.toFixed(1)} m`));
  }, [cube, pixel.row, pixel.col, s.rhIndexes]);

  const created = new Date(s.created);

  return (
    <div className="ex-static">
      <header className="ex-static__head">
        <div>
          <h1>{s.place ?? 'Vertical vegetation structure'}</h1>
          <p>
            {pinLat.toFixed(5)}, {pinLon.toFixed(5)} · tile {s.meta.tile} · VSM {s.meta.year} · saved{' '}
            {created.toISOString().slice(0, 10)}
          </p>
        </div>
        {s.explorerUrl && (
          <a className="ex-static__open" href={s.explorerUrl}>
            Open in the explorer ↗
          </a>
        )}
      </header>

      <main className="ex-static__main">
        {/* Only the snapshot's own images can be shown: there is no backend to fetch another. */}
        <CubePanel
          cube={cube}
          probe={probe}
          loading={!cube && !error}
          error={error}
          ground={ground}
          onGround={setGround}
          initialView={s.view}
          initialCamera={s.camera}
          onSnapshot={setSnap}
          preloaded={preloaded}
          layout="docked"
          onPick={(row, col) => setProbe({ row, col })}
          sideExtra={
            profile?.profile && (
              <section className="ex-static__profile" aria-label="Profile at the pin">
                <div className="ex-static__profile-head">
                  <div className="ex-reading__values">
                    {rows.map((t) => (
                      <span key={t} className="ex-chip">
                        {t}
                      </span>
                    ))}
                  </div>
                  <label className="ex-profile__ymax" title="Top of the height axis of both charts">
                    Height max
                    <input
                      type="number"
                      min={1}
                      step={5}
                      value={yMaxText}
                      onChange={(e) => setYMaxText(e.target.value)}
                    />
                    m
                  </label>
                </div>
                <ProfileMetrics {...profile} />
                <div className="ex-static__charts">
                  <figure>
                    <figcaption>RH profile</figcaption>
                    <RhProfileChart profile={profile.profile} yMax={yMax} />
                  </figure>
                  {profile.vertical_profile_curve && profile.vertical_profile_curve.length > 1 && (
                    <figure>
                      <figcaption>Vertical profile</figcaption>
                      <VerticalProfileChart curve={profile.vertical_profile_curve} yMax={yMax} />
                    </figure>
                  )}
                </div>
              </section>
            )
          }
        />
      </main>

      <footer className="ex-static__foot">
        Vertical vegetation structure (VSM) {s.meta.year}, 10 m · a {s.meta.size} × {s.meta.size} px window of tile{' '}
        {s.meta.tile}, data released under CC BY 4.0. This page is a saved copy: it works offline and does not
        change when the data do.
      </footer>
    </div>
  );
}

const el = document.getElementById('vsm-snapshot');
const root = document.getElementById('root');
if (el && root) {
  const s = JSON.parse(el.textContent || '{}') as PageSnapshot;
  createRoot(root).render(<Page s={s} />);
}
