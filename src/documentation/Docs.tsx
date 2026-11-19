import { useEffect } from 'react';
import { CitationRef, CopyBibtex } from '../components/Citation';
import { DOI } from '../components/citationData';
import { PartnerLogos } from '../components/PartnerLogos';
import { TopBar } from '../components/TopBar';
import './docs.css';

/**
 * The site's documentation: what the dataset is, how to read it, how to use
 * the explorer, and how to get the files.
 *
 * Every number here was checked against the published files or the
 * explorer's code (2026-11-12): file layout and Q1 from the backend's
 * /predictions/download-info; data type, nodata, grids and CRS from the file
 * headers on source.coop; sizes from their Content-Length; the zoom-7 switch
 * from vsmLayers.ts; the 6-file and 400-file limits from DownloadPanel.tsx.
 * The energy-profile maths from cubeData.ts and backend/utils.py (pixel_hist,
 * PROFILE_MIN_HEIGHT). Checked in ~/Code/mpc (2026-11-16): image selection
 * (download/products/sentinel2/inference.py, growing_season.py: calendar year,
 * growing months, up to 20 images), the per-pixel median over images and the
 * water/built-up/cloud/snow masks (datasets/zarr_dataset_deploy.py), the
 * WorldCover mask on coastal tiles (postprocessing/), the 1 km overview
 * (visualization/core/create_global_view.py, gdalwarp average at 0.01°) and
 * the Q0/Q1/Q2 quantiles 5/50/95 % (models/losses/quantile_ce_loss.py).
 * Change one there, change it here.
 */

const BASE = import.meta.env.BASE_URL;
const STORE = 'https://data.source.coop/geoai-ucph/gvsm';

/**
 * The example notebooks, in the code repository's notebooks/ folder. Colab
 * opens a notebook straight from a public GitHub repository, so each card
 * links there and to the file itself.
 */
const NOTEBOOK_REPO = 'huizhml/global-vegetation-structure';
const NOTEBOOK_BRANCH = 'master';
const TUTORIALS = [
  {
    file: '01_get_the_data.ipynb',
    title: 'Get the data',
    text: 'Read all 101 RH metrics over an area as a 3D datacube, sample them at points, and cut patches with the matching Sentinel-2 scene.',
  },
  {
    file: '02_structure_metrics.ipynb',
    title: 'Structural diversity indices from the RH profile',
    text: 'Compare two stands of the same canopy height in the Spessart, then map canopy ratio, foliage height diversity and the effective number of layers.',
  },
];

const SECTIONS = [
  { id: 'dataset', title: 'The dataset' },
  { id: 'rh', title: 'RH metrics' },
  { id: 'files', title: 'File format' },
  { id: 'download', title: 'Downloading' },
  { id: 'tutorials', title: 'Tutorials' },
  { id: 'cite', title: 'Licence and citation' },
];

export default function Docs() {
  // The page renders after the browser has looked for #section, so a link to a
  // section would land at the top; scroll there once it exists.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <div className="dc">
      <TopBar current="docs" />
      <div className="dc__layout">
        <nav className="dc__toc" aria-label="On this page">
          <span className="dc__toc-title">On this page</span>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <main className="dc__main">
          <h1>Documentation</h1>
          <p className="dc__lede">
            How to read the Vertical Vegetation Structure dataset, explore it on the map, and download it.
          </p>
          <nav className="dc__start" aria-label="Get started">
            <a href={`${BASE}explorer/`}>
              <span>explore</span>
              <span>map</span>
            </a>
            <a href="#tutorials">
              <span>notebooks</span>
              <span>Python</span>
            </a>
            <a href="#download">
              <span>download</span>
              <span>files</span>
            </a>
          </nav>

          <section id="dataset">
            <h2>The dataset</h2>
            <p>
              A 10-metre dataset of Earth's vertical vegetation structure for the year 2020, derived from NASA's GEDI
              LiDAR data and Sentinel-2 imagery. This dataset gives the full vertical profile beyond canopy top height
              through 101 relative height (RH) metrics, RH0 to RH100, for every 10 m pixel, with uncertainty estimates
              for each RH.
            </p>
            <ul>
              <li>
                <b>Year:</b> 2020. More years are in preparation.
              </li>
              <li>
                <b>Resolution:</b> 10 m
              </li>
              <li>
                <b>Coverage:</b> Global
              </li>
            </ul>
          </section>

          <section id="rh">
            <h2>RH profile</h2>
            <figure className="dc__figure">
              <a href={`${BASE}tour/rh-profile.webp`} target="_blank" rel="noreferrer" title="Open full size">
                <img
                  src={`${BASE}tour/rh-profile.webp`}
                  alt="Forest structure, its GEDI lidar energy profile, and the RH0–100 curve read from it"
                />
              </a>
              <figcaption>
                Vegetation structure within a GEDI footprint, the vertical distribution of returned lidar energy, and
                the corresponding relative height (RH) profile.
              </figcaption>
            </figure>
            <p>
              GEDI records the laser energy reflected by vegetation and the ground in each footprint.{' '}
              <b>
                RH<i>n</i>
              </b>{' '}
              is the height above ground below which <i>n</i>% of that returned energy has accumulated.
            </p>
            <ul>
              <li>
                <b>RH98–RH100:</b> approximate canopy top height, comparable to conventional canopy height products.
              </li>
              <li>
                <b>RH50:</b> the height below which half of the returned energy has accumulated.
              </li>
              <li>
                <b>Low RHs (RH0–RH25):</b> the lower part of the cumulative return, shaped by both vegetation and
                ground.
              </li>
            </ul>
            <p>Together, RH0 … RH100 make a cumulative vertical profile for each pixel.</p>

            <h3>From RH to vertical profile</h3>
            <p>
              The RH curve and the energy profile carry the same information. Each step from one RH to the next holds 1%
              of the returned energy, so the share of energy in a height bin is the share of RH metrics that fall in it.
              The explorer draws its vertical profile exactly this way: it counts how many of RH1–RH100 fall in each 1 m
              bin, each counting 1%, with no interpolation or smoothing.
            </p>
            <div className="dc__pair">
              <figure className="dc__figure">
                <img
                  src={`${BASE}tour/cube-rh.png`}
                  alt="3D cube with RH1 to RH100 on the vertical axis, coloured by height"
                />
                <figcaption>
                  <b>3D RH profile.</b> Vertical axis: RH1 at the bottom to RH100 at the top; colour: the height of each
                  RH.
                </figcaption>
              </figure>
              <figure className="dc__figure">
                <img
                  src={`${BASE}tour/cube-energy.png`}
                  alt="3D cube with height on the vertical axis, coloured by energy share per 1 m bin"
                />
                <figcaption>
                  <b>3D vertical profile.</b> Vertical axis: height, 0–50 m; colour: the share of energy in each 1 m
                  bin.
                </figcaption>
              </figure>
            </div>
            <p>Both cubes show the same 1.28 km window (55.446° N, 11.465° E, Denmark).</p>
            <p>
              Energy here is the predicted lidar return at each height: a relative measure of where vegetation and
              ground reflect the laser. It is not leaf area, vegetation volume or biomass.
            </p>
            <div className="dc__note">
              <b>Low RHs can be negative.</b> GEDI sets 0 m at the centre of the ground return, so part of the energy
              returned by the ground lies below 0 m. Low RHs are therefore often negative, most of all where vegetation
              is sparse. The model learned from these RH values and inherits this characteristic.
              {/* The profile chart for a clicked pixel keeps them (down to −10 m) to show the whole return, ground included. The 3D
              cube and the example-site transects show only positive values, so there a pixel's bins add up to
              less than 100% when its low RHs are negative. */}
            </div>
          </section>

          <section id="files">
            <h2>File format</h2>
            <p>
              The data is stored as single-band Cloud-Optimized GeoTIFF per RH and quantile (and per tile for 10 m), named{' '}
              <code>{'RH{n}_Q{q}.tif'}</code>:
            </p>
            <ul>
              <li>
                <code>{'RH{n}'}</code> — the RH, 0 to 100.
              </li>
              <li>
                <code>{'Q{q}'}</code> — which quantile of the model's prediction the file holds. For every RH the model
                predicts three: <code>Q0</code> the 5% quantile, <code>Q1</code> the median, <code>Q2</code> the 95% quantile. <code>Q0</code> and <code>Q2</code> bound a
                90% prediction interval. <code>Q1</code> is published for the year 2020; <code>Q0</code> and{' '}
                <code>Q2</code> are being uploaded.
              </li>
            </ul>
            <table className="dc__table">
              <thead>
                <tr>
                  <th />
                  <th>10 m tiles</th>
                  <th>~1 km overview</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Grid</th>
                  <td>10980 × 10980 pixels of 10 m — one Sentinel-2 (MGRS) tile</td>
                  <td>36000 × 13889 pixels of 0.01° (~1.1 km at the equator)</td>
                </tr>
                <tr>
                  <th>Coordinate system</th>
                  <td>The tile's UTM zone (e.g. EPSG:32632)</td>
                  <td>WGS 84 (EPSG:4326)</td>
                </tr>
                <tr>
                  <th>Values</th>
                  <td colSpan={2}>
                    16-bit integers in <b>decimetres</b>. Mask the no-data value <code>32767</code> first, then divide
                    by 10 for metres.
                  </td>
                </tr>
                <tr>
                  <th>Layout</th>
                  <td colSpan={2}>Internally tiled and compressed (ZSTD), with overviews at 2× to 32×.</td>
                </tr>
              </tbody>
            </table>
            <p>
              In the ~1 km overview each cell is the mean of the valid 10 m pixels inside it, taken separately for each
              RH.
            </p>
            <p>
              Because the files are cloud-optimized, a window can be read without downloading the whole file, e.g. with
              GDAL:
            </p>
            <pre>
              <code>
                {`gdal_translate -projwin_srs EPSG:4326 -projwin 9.28 49.95 9.32 49.92 \\
  /vsicurl/${STORE}/2020/32UNA/RH98_Q1.tif spessart_rh98.tif`}
              </code>
            </pre>
          </section>

          <section id="download">
            <h2>Downloading</h2>
            <p>
              <b>Download data</b> in the explorer's panel opens a panel with four steps:
            </p>
            <ol className="dc__steps">
              <li>
                <b>Choose RH metrics</b> — any of the 101, all of them, or the ones on the map (the default).
              </li>
              <li>
                <b>Choose resolution</b> — <b>10 m tiles</b>, one file per Sentinel-2 tile and RH, or the{' '}
                <b>~1 km global</b> overview, one file per RH for the whole world.
              </li>
              <li>
                <b>Choose tiles</b> (10 m only) — click tiles on the map, or take <b>All in view</b>.
              </li>
              <li>
                <b>Download</b> — up to six files download directly, named by product, year, RH and tile. Beyond that
                the panel writes a shell script that fetches them with <code>curl</code>, names each file and resumes a
                broken transfer (up to 400 files per script). Run it in a terminal with <code>sh gvsm_2020_….sh</code>;
                the files land in the current folder. <b>Copy URLs</b> gives the plain list.
              </li>
            </ol>
            <p>
              Files are roughly 85–170 MB each, at both resolutions. All of them can also be fetched straight from the{' '}
              <a href="https://source.coop/geoai-ucph/gvsm" target="_blank" rel="noreferrer">
                repository on Source Cooperative
              </a>
              , which serves them over HTTP with range requests:
            </p>
            <pre>
              <code>
                {`${STORE}/2020/{TILE}/RH{n}_Q1.tif       # 10 m, per Sentinel-2 tile
${STORE}/mosaics/2020/RH{n}_Q1.tif    # ~1 km global overview

# e.g. RH98 of tile 32UNA (Spessart, Germany):
${STORE}/2020/32UNA/RH98_Q1.tif`}
              </code>
            </pre>
            <p>
              <code>{'{TILE}'}</code> is the Sentinel-2 (MGRS) tile ID, such as <code>32UNA</code>. The tile grid the
              download panel draws on the map is labelled with these IDs, and the first tutorial finds the tile for a
              coordinate.
            </p>
            <p>
              For bulk access to the full dataset, contact us at{' '}
              <a href="mailto:huzh@di.ku.dk?cc=nila@di.ku.dk,igel@di.ku.dk">{'{huzh,nila,igel}@di.ku.dk'}</a>.
            </p>
          </section>

          <section id="tutorials">
            <h2>Tutorials</h2>
            <p>
              Example notebooks that read the data straight from Source Cooperative. Each opens and runs in Google
              Colab.
            </p>
            <div className="dc__tutorials">
              {TUTORIALS.map((t) => (
                <article key={t.file} className="dc__tutorial">
                  <h3>{t.title}</h3>
                  <p>{t.text}</p>
                  <div className="dc__tutorial-links">
                    <a
                      href={`https://colab.research.google.com/github/${NOTEBOOK_REPO}/blob/${NOTEBOOK_BRANCH}/notebooks/${t.file}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open in Colab" />
                    </a>
                    <a
                      className="dc__tutorial-src"
                      href={`https://github.com/${NOTEBOOK_REPO}/blob/${NOTEBOOK_BRANCH}/notebooks/${t.file}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on GitHub
                    </a>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section id="cite">
            <h2>Licence and citation</h2>
            <p>
              The data are released under{' '}
              <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
                CC BY 4.0
              </a>{' '}
              — free to use and adapt, including commercially, with attribution. Please cite:
            </p>
            <blockquote className="dc__cite">
              <CitationRef />
              <CopyBibtex className="dc__cite-copy" />
            </blockquote>
          </section>
        </main>
      </div>
      <footer className="dc__foot">
        <PartnerLogos variant="strip" />
      </footer>
    </div>
  );
}
