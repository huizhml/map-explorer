import { useCallback, useEffect, useRef, useState } from 'react';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Feature } from 'ol';
import { Geometry, Point, Polygon, LineString, MultiPolygon, MultiLineString } from 'ol/geom';
import { Style, Stroke, Fill, Circle as CircleStyle, Text as TextStyle } from 'ol/style';
import Draw from 'ol/interaction/Draw';
import { never } from 'ol/events/condition';
import { transform } from 'ol/proj';
import {
  bindShiftKeyRef,
  createSquareWhenShift,
  horizontalLineWhenShift,
  primaryPointerAllowShift,
} from '../utils/drawConstraints';
import { useMapStore } from '../stores/mapStore';
import { inspectPointAtLonLat } from '../utils/inspectPoint';
import { fetchVerticalProfile, fetchVerticalProfileLine } from '../utils/verticalProfile';
import type { GediPointData } from '../components/GediPointPopup';
import type { SavedMapFeatureGeometry } from '../stores/mapStore';

const MIN_CLUSTER_SIZE = 20;

export function useMapInteractions(updateLayersList: () => void) {
  const {
    map, fgbLayer, highlightLayer, setHighlightLayer,
    setPopupProperties, setPopupPosition, setPopupGeometry, setPopupCoordinates,
  } = useMapStore();
  const {
    drawingActive,
    drawingMode,
    inspectMode,
    inspectKind,
    featureCaptureType,
    vsmYear,
    diversityHeightBinM,
    setDrawingActive,
    setSelectedTiles,
    figureSelectionExtent,
    setFigureSelectionExtent,
    setFeatureCaptureType,
    setFeatureDraft,
  } = useMapStore();

  const transectHeatmapSampleIndex = useMapStore((s) => s.transectHeatmapSampleIndex);
  const inspectPanel = useMapStore((s) => s.inspectPanel);

  const inspectRequestIdRef = useRef(0);
  const inspectPinLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const inspectPinFeatureRef = useRef<Feature<Point> | null>(null);
  const drawLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const labelLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const inspectLineLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const inspectLineDrawRef = useRef<Draw | null>(null);
  const highlightedGediRef = useRef<Feature<Geometry> | null>(null);
  const [gediPointPopup, setGediPointPopup] = useState<GediPointData | null>(null);
  /** Synced for Draw geometry helpers (Shift + horizontal line / square box). */
  const shiftKeyHeldRef = useRef(false);

  const getVisibleClickableFgbLayers = (): any[] => {
    const manager = useMapStore.getState().layerManager;
    const managedLayers = manager
      ? manager
        .getLayersByType('fgb')
        .filter((managed: any) => managed?.visible && managed?.layer)
      : [];
    if (managedLayers.length > 0) return managedLayers;

    // Fallback for moments where layer manager hasn't registered yet.
    const fallbackFgb = useMapStore.getState().fgbLayer;
    return fallbackFgb ? [{ layer: fallbackFgb, visible: fallbackFgb.getVisible?.() !== false }] : [];
  };

  const isClickableFgbLayer = (layer: any): boolean => {
    const visibleFgbLayers = getVisibleClickableFgbLayers();
    return visibleFgbLayers.some((managed: any) => managed.layer === layer);
  };

  const clearInspectPin = useCallback(() => {
    inspectPinLayerRef.current?.getSource()?.clear();
    inspectPinFeatureRef.current = null;
  }, []);

  const clearInspectLine = useCallback(() => {
    useMapStore.getState().setTransectHeatmapSampleIndex(null);
    if (inspectLineLayerRef.current) {
      inspectLineLayerRef.current.getSource()?.clear();
      map?.removeLayer(inspectLineLayerRef.current);
      inspectLineLayerRef.current = null;
    }
  }, [map]);

  const setInspectPinAtCoordinate = useCallback((coordinate: number[]) => {
    const src = inspectPinLayerRef.current?.getSource();
    if (!src) return;
    src.clear();
    const pin = new Feature({ geometry: new Point(coordinate) });
    src.addFeature(pin);
    inspectPinFeatureRef.current = pin;
  }, []);

  // Inspect pin layer
  useEffect(() => {
    if (!map) return;
    const source = new VectorSource();
    const layer = new VectorLayer({
      source, zIndex: 1200,
      style: new Style({ image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#d32f2f' }), stroke: new Stroke({ color: '#ffffff', width: 2 }) }) }),
    });
    map.addLayer(layer);
    inspectPinLayerRef.current = layer;
    return () => { map.removeLayer(layer); inspectPinLayerRef.current = null; inspectPinFeatureRef.current = null; };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const el = map.getTargetElement();
    return bindShiftKeyRef(el, shiftKeyHeldRef);
  }, [map]);

  // Cursor for inspect mode
  useEffect(() => {
    if (!map) return;
    const el = map.getTargetElement();
    if (!el) return;
    const { inspectMode, drawingActive: da } = useMapStore.getState();
    if (inspectMode && !da) el.style.cursor = 'crosshair';
    else if (!da) el.style.cursor = '';
  }, [map, useMapStore.getState().inspectMode, drawingActive]);

  useEffect(() => { if (!useMapStore.getState().inspectMode) clearInspectPin(); }, [useMapStore.getState().inspectMode, clearInspectPin]);

  // Hide all feature popups while drawing tools are active
  useEffect(() => {
    if (!drawingActive) return;
    setPopupProperties(null);
    setPopupPosition(null);
    setPopupGeometry(null);
    setPopupCoordinates(null);
    setGediPointPopup(null);
    highlightLayer?.getSource()?.clear();
  }, [
    drawingActive,
    highlightLayer,
    setPopupProperties,
    setPopupPosition,
    setPopupGeometry,
    setPopupCoordinates,
  ]);

  // Highlight layer
  useEffect(() => {
    if (!map) return;
    const hl = new VectorLayer({
      source: new VectorSource(),
      style: new Style({
        stroke: new Stroke({ color: '#ff0000', width: 4 }),
        fill: new Fill({ color: '#ff000000' }),
        image: new CircleStyle({ radius: 10, stroke: new Stroke({ color: '#ff0000', width: 4 }), fill: new Fill({ color: 'rgba(255, 0, 0, 0.5)' }) }),
      }),
      zIndex: 10000,
    });
    hl.setVisible(true);
    map.addLayer(hl);
    setHighlightLayer(hl);
    return () => { map.removeLayer(hl); };
  }, [map]);

  const createHighlightGeometry = useCallback((geometry: Geometry): Geometry | null => {
    if (!geometry) return null;
    try {
      const geomType = geometry.getType();
      let coords: any = typeof (geometry as any).getCoordinates === 'function' ? (geometry as any).getCoordinates() : null;
      if (!coords) {
        const ext = geometry.getExtent();
        if (ext?.length === 4) {
          const [a, b, c, d] = ext;
          return new Polygon([[[a, b], [c, b], [c, d], [a, d], [a, b]]]);
        }
        return null;
      }
      if (geomType === 'Polygon') return new Polygon(coords);
      if (geomType === 'MultiPolygon') return new MultiPolygon(coords);
      if (geomType === 'LineString') return new LineString(coords);
      if (geomType === 'MultiLineString') return new MultiLineString(coords);
      if (geomType === 'Point') return new Point(coords);
    } catch { /* ignore */ }
    return null;
  }, []);

  // Clear the persistent rectangle layer when the export extent is reset
  // (e.g. when the user locates a saved feature, or after a successful save).
  // Without this the user would see a rectangle on the map but the export
  // panel would say "Draw a rectangle first" because the state is null.
  useEffect(() => {
    if (figureSelectionExtent === null && drawLayerRef.current && map) {
      map.removeLayer(drawLayerRef.current);
      drawLayerRef.current = null;
    }
  }, [figureSelectionExtent, map]);

  // Draw interaction
  useEffect(() => {
    if (!map || !drawingActive) return;
    if (drawLayerRef.current) { map.removeLayer(drawLayerRef.current); drawLayerRef.current = null; }
    if (labelLayerRef.current) { map.removeLayer(labelLayerRef.current); labelLayerRef.current = null; }

    const drawSource = new VectorSource();
    // Attach drawSource to a visible VectorLayer so the drawn rectangle stays
    // on the map after drawend (without it, the OL sketch disappears and the
    // user has no visual confirmation of their selection extent).
    const drawLayer = new VectorLayer({
      source: drawSource,
      style: new Style({
        stroke: new Stroke({ color: 'rgba(33, 150, 243, 0.95)', width: 2 }),
        fill: new Fill({ color: 'rgba(33, 150, 243, 0.10)' }),
      }),
      zIndex: 9500,
    });
    map.addLayer(drawLayer);
    drawLayerRef.current = drawLayer;

    const drawInteraction = new Draw({
      source: drawSource,
      type: 'Circle',
      condition: primaryPointerAllowShift,
      // `freehandCondition` defaults to `shiftKeyOnly`, which would put the
      // interaction into freehand mode the moment the user pressed Shift to
      // request a square — the geometryFunction wouldn't be honoured and the
      // drawn shape wouldn't end up in the source. Disable it: Shift is for
      // the geometry function only (via shiftKeyHeldRef), never for freehand.
      freehandCondition: never,
      geometryFunction: createSquareWhenShift(shiftKeyHeldRef),
    });
    map.addInteraction(drawInteraction);
    const mapEl = map.getTargetElement();
    if (mapEl) mapEl.style.cursor = 'crosshair';

    drawInteraction.on('drawend', (event: any) => {
      const geom = event.feature.getGeometry();
      if (!geom) return;
      const drawnExtent = geom.getExtent() as [number, number, number, number];
      if (drawingMode === 'figures' || drawingMode === 'figures_db') {
        setFigureSelectionExtent(drawnExtent);
      } else {
        const fgb = useMapStore.getState().fgbLayer;
        if (!fgb) { setDrawingActive(false); return; }
        const fgbSource = fgb.getSource();
        if (!fgbSource) return;

        const features = fgbSource.getFeaturesInExtent(drawnExtent);
        const tileNames: string[] = [];
        const labelFeatures: Feature<Geometry>[] = [];

        for (const f of features) {
          const name = f.get('Name');
          if (name && typeof name === 'string') {
            tileNames.push(name);
            const g = f.getGeometry();
            if (g) {
              const ext = g.getExtent();
              labelFeatures.push(new Feature({ geometry: new Point([(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2]), tileName: name }));
            }
          }
        }
        tileNames.sort();
        setSelectedTiles(tileNames);

        if (drawLayerRef.current) { map.removeLayer(drawLayerRef.current); drawLayerRef.current = null; }
        if (labelLayerRef.current) { map.removeLayer(labelLayerRef.current); labelLayerRef.current = null; }

        const lblLayer = new VectorLayer({
          source: new VectorSource({ features: labelFeatures }),
          style: (f: any) => new Style({ text: new TextStyle({ text: f.get('tileName') || '', font: 'bold 16px sans-serif', fill: new Fill({ color: '#FFD700' }), stroke: new Stroke({ color: '#000000', width: 3 }), overflow: true }) }),
          zIndex: 9001,
        });
        map.addLayer(lblLayer);
        labelLayerRef.current = lblLayer;

        const mgr = useMapStore.getState().layerManager;
        const labelLayerId = `vector-tiles-${Date.now()}`;
        if (mgr) {
          mgr.addLayer(labelLayerId, `Selected Tiles (${tileNames.length})`, 'vector', lblLayer, { featureNames: tileNames });
          updateLayersList();
        }
      }

      map.removeInteraction(drawInteraction);
      if (mapEl) mapEl.style.cursor = '';
      setDrawingActive(false);
    });

    return () => {
      map.removeInteraction(drawInteraction);
      const el = map.getTargetElement();
      if (el) el.style.cursor = '';
    };
  }, [map, drawingActive, drawingMode, setFigureSelectionExtent]);

  // Draw a saved feature geometry while inspect mode is active.
  useEffect(() => {
    if (!map || !inspectMode || drawingActive) return;
    if (featureCaptureType !== 'LineString' && featureCaptureType !== 'Polygon') return;

    const source = new VectorSource();
    const layer = new VectorLayer({
      source,
      zIndex: 1400,
      style: new Style({
        stroke: new Stroke({ color: '#8e24aa', width: 3 }),
        fill: new Fill({ color: 'rgba(142, 36, 170, 0.15)' }),
        image: new CircleStyle({
          radius: 5,
          fill: new Fill({ color: '#8e24aa' }),
          stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
        }),
      }),
    });
    map.addLayer(layer);

    const draw = new Draw({
      source,
      type: featureCaptureType,
      condition: primaryPointerAllowShift,
      geometryFunction:
        featureCaptureType === 'LineString'
          ? horizontalLineWhenShift(shiftKeyHeldRef)
          : undefined,
    });
    map.addInteraction(draw);

    const mapEl = map.getTargetElement();
    if (mapEl) mapEl.style.cursor = 'crosshair';

    draw.on('drawend', (event: { feature: Feature<Geometry> }) => {
      const geom = event.feature.getGeometry();
      if (!geom) {
        setFeatureCaptureType(null);
        return;
      }

      const transformed = geom.clone().transform('EPSG:3857', 'EPSG:4326');
      let geometryPayload: SavedMapFeatureGeometry | null = null;

      if (featureCaptureType === 'LineString' && transformed instanceof LineString) {
        geometryPayload = {
          type: 'LineString',
          coordinates: transformed.getCoordinates() as [number, number][],
        };
      }
      if (featureCaptureType === 'Polygon' && transformed instanceof Polygon) {
        const rings = transformed.getCoordinates();
        if (rings.length > 0) {
          geometryPayload = {
            type: 'Polygon',
            coordinates: rings as [number, number][][],
          };
        }
      }

      if (geometryPayload) {
        setFeatureDraft({ geometry: geometryPayload });
      }
      setFeatureCaptureType(null);
    });

    return () => {
      map.removeInteraction(draw);
      map.removeLayer(layer);
      const el = map.getTargetElement();
      if (el) el.style.cursor = '';
    };
  }, [map, inspectMode, drawingActive, featureCaptureType, setFeatureCaptureType, setFeatureDraft]);

  // Draw line for vertical profile transect inspect mode
  useEffect(() => {
    if (!map) return;
    if (!(inspectMode && inspectKind === 'vertical_profile_line') || drawingActive || featureCaptureType) return;

    // Create the layer only once; keep it alive across deactivations so the
    // drawn line persists until the panel is explicitly closed.
    if (!inspectLineLayerRef.current) {
      const newSource = new VectorSource();
      const layer = new VectorLayer({
        source: newSource,
        zIndex: 1300,
        style: (f) => {
          if (f.get('transectHeatmapHover')) {
            return new Style({
              image: new CircleStyle({
                radius: 10,
                fill: new Fill({ color: 'rgba(255, 152, 0, 0.95)' }),
                stroke: new Stroke({ color: '#ffffff', width: 3 }),
              }),
            });
          }
          const t = f.getGeometry()?.getType();
          if (t === 'Point' || t === 'MultiPoint') {
            return new Style({ image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#1976d2' }), stroke: new Stroke({ color: '#ffffff', width: 2 }) }) });
          }
          return new Style({ stroke: new Stroke({ color: '#1976d2', width: 4 }), image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#1976d2' }), stroke: new Stroke({ color: '#ffffff', width: 2 }) }) });
        },
      });
      map.addLayer(layer);
      inspectLineLayerRef.current = layer;
    }

    const source = inspectLineLayerRef.current.getSource()!;

    const draw = new Draw({
      source,
      type: 'LineString',
      condition: primaryPointerAllowShift,
      freehand: false,
      freehandCondition: never,
      geometryFunction: horizontalLineWhenShift(shiftKeyHeldRef),
      // Style function ensures the sketch line and vertices are both rendered
      // regardless of which sub-geometry OL passes during drawing.
      style: (f) => {
        const t = f.getGeometry()?.getType();
        if (t === 'Point' || t === 'MultiPoint') {
          return new Style({ image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#1976d2' }), stroke: new Stroke({ color: '#ffffff', width: 2 }) }) });
        }
        return new Style({ stroke: new Stroke({ color: '#1976d2', width: 4, lineDash: [10, 6] }), image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#1976d2' }), stroke: new Stroke({ color: '#ffffff', width: 2 }) }) });
      },
    });
    inspectLineDrawRef.current = draw;
    map.addInteraction(draw);

    const mapEl = map.getTargetElement();
    if (mapEl) mapEl.style.cursor = 'crosshair';

    draw.on('drawstart', () => {
      useMapStore.getState().setTransectHeatmapSampleIndex(null);
      // Do not clear `source` here: a new draw aborts often (pan, mis-click, Escape).
      // Clearing only on successful drawend keeps the last transect visible until replaced.
      clearInspectPin();
      useMapStore.getState().setInspectPanel((prev) => ({
        lon: prev?.lon ?? 0,
        lat: prev?.lat ?? 0,
        layers: [],
        loading: true,
        kind: 'vertical_profile_line',
        profileMeta: {
          tileName: '',
          year: vsmYear,
          qIndex: 1,
          source: vsmYear === 2020 ? 'original' : 'blended',
          maxHeight: undefined,
          heatmapMaxHeight: undefined,
          fhdInterval: useMapStore.getState().diversityHeightBinM,
        },
        transectProfile: prev?.kind === 'vertical_profile_line' ? prev.transectProfile : undefined,
        inspectError: null,
      }));
    });

    draw.on('drawend', (event: any) => {
      const geom = event.feature.getGeometry();
      if (!(geom instanceof LineString)) return;
      const coords3857 = geom.getCoordinates();
      if (coords3857.length < 2) {
        useMapStore.getState().setInspectPanel(null);
        return;
      }
      // Remove prior transect feature(s). OpenLayers adds `event.feature` to `source`
      // immediately after this listener returns.
      source.clear();
      const lineCoordinates = coords3857.map((c) => transform(c, 'EPSG:3857', 'EPSG:4326') as [number, number]);
      const first = lineCoordinates[0];
      const req = ++inspectRequestIdRef.current;

      fetchVerticalProfileLine(lineCoordinates, vsmYear, diversityHeightBinM).then((data) => {
        if (req !== inspectRequestIdRef.current) return;
        if (!data.success || !data.samples || data.samples.length === 0 || !data.vertical_profile) {
          useMapStore.getState().setInspectPanel({
            lon: first[0],
            lat: first[1],
            layers: [],
            loading: false,
            kind: 'vertical_profile_line',
            profileMeta: {
              tileName: '',
              year: data.year ?? vsmYear,
              qIndex: data.q_index ?? 1,
              source: data.source,
              maxHeight: data.max_height,
              heatmapMaxHeight: data.heatmap_max_height,
              fhdInterval: data.fhd_interval ?? diversityHeightBinM,
            },
            transectProfile: undefined,
            inspectError: data.error || 'Failed to sample line profile',
          });
          return;
        }
        const rhMatrix = data.vertical_profile;
        useMapStore.getState().setInspectPanel({
          lon: first[0],
          lat: first[1],
          layers: [],
          loading: false,
          kind: 'vertical_profile_line',
          profileMeta: {
            tileName: '',
            year: data.year ?? vsmYear,
            qIndex: data.q_index ?? 1,
            source: data.source,
            maxHeight: data.max_height,
            heatmapMaxHeight: data.heatmap_max_height,
            fhdInterval: data.fhd_interval ?? diversityHeightBinM,
          },
          transectProfile: {
            lineCoordinates: data.line_coordinates ?? lineCoordinates,
            sampleCount: data.sample_count ?? data.samples.length,
            totalLengthMeters: data.total_length_m ?? 0,
            samples: data.samples.map((s) => ({
              index: s.index,
              distance_m: s.distance_m,
              lon: s.lon,
              lat: s.lat,
              profile: (
                rhMatrix[s.index]
                ?? Array.from({ length: Math.max(1, data.max_height ?? rhMatrix[0]?.length ?? 0) }, () => null)
              ).map((value, rh) => ({
                rh,
                value,
                missing: value == null,
              })),
              vertical_profile_curve: s.vertical_profile_curve,
              fhd: s.fhd ?? null,
              enl1d: s.enl1d ?? null,
              enl2d: s.enl2d ?? null,
              cr: s.cr ?? null,
              tile_name: s.tile_name,
            })),
          },
          inspectError: null,
        });
      });
    });

    return () => {
      // Only remove the Draw interaction — keep the layer so the drawn line
      // stays visible on the map until the user explicitly closes the panel.
      if (inspectLineDrawRef.current) {
        map.removeInteraction(inspectLineDrawRef.current);
        inspectLineDrawRef.current = null;
      }
      const el = map.getTargetElement();
      if (el) el.style.cursor = '';
    };
  }, [map, clearInspectPin, inspectMode, inspectKind, drawingActive, featureCaptureType, vsmYear, diversityHeightBinM]);

  // Transect heatmap: mirror hovered/locked column as a point on the map line.
  useEffect(() => {
    const layer = inspectLineLayerRef.current;
    const source = layer?.getSource();
    if (!map || !source) return;

    source.getFeatures().forEach((f) => {
      if (f.get('transectHeatmapHover')) source.removeFeature(f);
    });

    const idx = transectHeatmapSampleIndex;
    const samples = inspectPanel?.transectProfile?.samples;
    if (
      idx == null ||
      inspectPanel?.kind !== 'vertical_profile_line' ||
      !samples?.length ||
      idx < 0 ||
      idx >= samples.length
    ) {
      return;
    }

    const sample = samples[idx];
    if (!Number.isFinite(sample.lon) || !Number.isFinite(sample.lat)) return;

    const coord3857 = transform([sample.lon, sample.lat], 'EPSG:4326', 'EPSG:3857');
    const feat = new Feature({ geometry: new Point(coord3857) });
    feat.set('transectHeatmapHover', true);
    source.addFeature(feat);
  }, [map, transectHeatmapSampleIndex, inspectPanel?.kind, inspectPanel?.transectProfile?.samples]);

  // Hover + delete overlay on vector label features (skip GEDI)
  useEffect(() => {
    if (!map) return;
    const deleteEl = document.createElement('div');
    deleteEl.innerHTML = '✕';
    deleteEl.style.cssText = 'background:#ff4444;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:none;user-select:none;';

    let overlay: any = null;
    let hoveredFeature: Feature<Geometry> | null = null;
    let hoveredLayerId: string | null = null;

    const setup = async () => {
      const { default: OlOverlay } = await import('ol/Overlay');
      overlay = new OlOverlay({ element: deleteEl, positioning: 'bottom-left', offset: [5, -5], stopEvent: true });
      map.addOverlay(overlay);
      deleteEl.style.display = 'none';

      deleteEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hoveredFeature || !hoveredLayerId) return;
        const mgr = useMapStore.getState().layerManager;
        if (!mgr) return;
        const managed = mgr.getLayer(hoveredLayerId);
        if (!managed) return;
        const source = (managed.layer as any).getSource?.();
        if (!source) return;
        const tileName = hoveredFeature.get('tileName');
        source.removeFeature(hoveredFeature);
        const tiles = useMapStore.getState().selectedTiles;
        useMapStore.getState().setSelectedTiles(tiles.filter((t: string) => t !== tileName));
        const remaining = source.getFeatures().length;
        if (remaining === 0) { mgr.removeLayer(hoveredLayerId); map.removeLayer(managed.layer); }
        else (managed as any).name = `Selected Tiles (${remaining})`;
        updateLayersList();
        deleteEl.style.display = 'none';
        overlay.setPosition(undefined);
        hoveredFeature = null; hoveredLayerId = null;
      });

      const onPointerMove = (evt: any) => {
        if (evt.dragging) return;
        const mgr = useMapStore.getState().layerManager;
        if (!mgr) return;
        const vectorLayers = mgr.getLayersByType('vector');
        if (vectorLayers.length === 0) {
          if (hoveredFeature) { hoveredFeature.setStyle(undefined); hoveredFeature = null; hoveredLayerId = null; deleteEl.style.display = 'none'; overlay.setPosition(undefined); }
          return;
        }
        let found = false;
        map.forEachFeatureAtPixel(evt.pixel, (feature: any) => {
          if (found) return;
          for (const managed of vectorLayers) {
            if (managed.id.startsWith('gedi-')) continue;
            const src = (managed.layer as any).getSource?.();
            if (src && src.getFeatures().includes(feature)) {
              found = true;
              if (hoveredFeature !== feature) {
                if (hoveredFeature) hoveredFeature.setStyle(undefined);
                feature.setStyle(new Style({ text: new TextStyle({ text: feature.get('tileName') || '', font: 'bold 22px sans-serif', fill: new Fill({ color: '#FFFFFF' }), stroke: new Stroke({ color: '#FF0000', width: 4 }), overflow: true }) }));
                hoveredFeature = feature; hoveredLayerId = managed.id;
                const geom = feature.getGeometry();
                if (geom) { overlay.setPosition((geom as any).getCoordinates()); deleteEl.style.display = 'flex'; }
              }
              return;
            }
          }
        }, { hitTolerance: 10 });
        if (!found && hoveredFeature) {
          hoveredFeature.setStyle(undefined); hoveredFeature = null; hoveredLayerId = null;
          deleteEl.style.display = 'none'; overlay.setPosition(undefined);
        }
      };
      map.on('pointermove', onPointerMove);
      (deleteEl as any).__onPointerMove = onPointerMove;
    };
    setup();
    return () => {
      if (overlay) map.removeOverlay(overlay);
      const pm = (deleteEl as any).__onPointerMove;
      if (pm) map.un('pointermove', pm);
      if (hoveredFeature) hoveredFeature.setStyle(undefined);
      deleteEl.remove();
    };
  }, [map, updateLayersList]);

  // Click + pointer move for FGB features and GEDI points
  useEffect(() => {
    if (!map || !highlightLayer) return;

    const handleClick = (evt: any) => {
      const { inspectMode: im, drawingActive: drawOn, layerManager: mgr } = useMapStore.getState();
      if (drawOn) {
        setPopupProperties(null);
        setPopupPosition(null);
        setPopupGeometry(null);
        setPopupCoordinates(null);
        setGediPointPopup(null);
        highlightLayer.getSource()?.clear();
        return;
      }

      if (im && !drawOn) {
        if (useMapStore.getState().featureCaptureType === 'Point') {
          setInspectPinAtCoordinate(evt.coordinate);
          const [lon, lat] = transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
          useMapStore.getState().setFeatureDraft({
            geometry: {
              type: 'Point',
              coordinates: [lon, lat],
            },
          });
          useMapStore.getState().setFeatureCaptureType(null);
          return;
        }

        const { inspectKind, vsmYear } = useMapStore.getState();
        if (inspectKind === 'vertical_profile_line') return;

        setInspectPinAtCoordinate(evt.coordinate);
        const [lon, lat] = transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
        const req = ++inspectRequestIdRef.current;

        if (inspectKind === 'vertical_profile') {
          useMapStore.getState().setInspectPanel((prev) => {
            const stale = prev?.kind === 'vertical_profile' && prev.verticalProfile?.length;
            return stale
              ? { ...prev!, loading: true, pendingSample: { lon, lat } }
              : { lon, lat, layers: [], loading: true, kind: 'vertical_profile', pendingSample: undefined, inspectError: null };
          });
          fetchVerticalProfile(lon, lat, vsmYear, diversityHeightBinM).then((data) => {
            if (req !== inspectRequestIdRef.current) return;
            if (!data.success || !data.profile) {
              useMapStore.getState().setInspectPanel((prev) => ({
                lon, lat, layers: [], loading: false, kind: 'vertical_profile' as const,
                verticalProfile: prev?.verticalProfile, verticalProfileCurve: prev?.verticalProfileCurve,
                profileMetrics: prev?.profileMetrics,
                profileMeta: prev?.profileMeta, pendingSample: undefined, inspectError: data.error || 'Failed',
              }));
              return;
            }
            useMapStore.getState().setInspectPanel({
              lon, lat, layers: [], loading: false, kind: 'vertical_profile',
              verticalProfile: data.profile, verticalProfileCurve: data.vertical_profile_curve,
              profileMetrics: {
                fhd: data.fhd ?? null,
                enl1d: data.enl1d ?? null,
                enl2d: data.enl2d ?? null,
                cr: data.cr ?? null,
              },
              profileMeta: {
                tileName: data.tile_name || '',
                year: data.year ?? vsmYear,
                qIndex: data.q_index ?? 1,
                source: data.source,
                maxHeight: data.max_height,
                heatmapMaxHeight: data.heatmap_max_height,
                fhdInterval: data.fhd_interval ?? diversityHeightBinM,
              },
              pendingSample: undefined, inspectError: null,
            });
          });
          return;
        }

        useMapStore.getState().setInspectPanel((prev) => {
          const stale = prev && prev.layers.length > 0 && (prev.kind === 'layers' || prev.kind === undefined);
          return stale
            ? { lon: prev!.lon, lat: prev!.lat, layers: prev!.layers, loading: true, kind: 'layers' as const, pendingSample: { lon, lat } }
            : { lon, lat, layers: prev?.kind === 'layers' ? (prev?.layers ?? []) : [], loading: true, kind: 'layers' as const, pendingSample: undefined };
        });
        inspectPointAtLonLat(mgr, lon, lat).then((layers) => {
          if (req !== inspectRequestIdRef.current) return;
          useMapStore.getState().setInspectPanel({ lon, lat, loading: false, layers, kind: 'layers', pendingSample: undefined });
        });
        return;
      }

      highlightLayer.getSource()?.clear();

      // GEDI click
      if (highlightedGediRef.current) {
        highlightedGediRef.current.setStyle(undefined);
        highlightedGediRef.current = null;
      }
      const gediMgr = useMapStore.getState().layerManager;
      if (gediMgr) {
        const gediLayers = gediMgr.getLayersByType('vector').filter((m: any) => m.id.startsWith('gedi-'));
        let hit = false;
        map.forEachFeatureAtPixel(evt.pixel, (feature: any) => {
          if (hit) return;
          for (const managed of gediLayers) {
            const src = (managed.layer as any).getSource?.();
            if (src && src.getFeatures().includes(feature)) {
              hit = true;
              feature.setStyle(new Style({
                image: new CircleStyle({
                  radius: 8,
                  fill: new Fill({ color: 'rgba(255, 235, 59, 0.9)' }),
                  stroke: new Stroke({ color: '#e65100', width: 2.5 }),
                }),
              }));
              highlightedGediRef.current = feature;
              const geom = feature.getGeometry();
              const featureCoord = geom && typeof geom.getCoordinates === 'function'
                ? geom.getCoordinates() : evt.coordinate;
              setGediPointPopup({ coordinate: featureCoord, properties: feature.getProperties() });
              return;
            }
          }
        }, { hitTolerance: 6 });
        if (hit) return;
      }
      setGediPointPopup(null);

      // Uploaded vector layer click
      const uploadMgr = useMapStore.getState().layerManager;
      if (uploadMgr) {
        const uploadLayers = uploadMgr.getLayersByType('vector').filter((m: any) => m.id.startsWith('upload-'));
        if (uploadLayers.length > 0) {
          let uploadHit = false;
          map.forEachFeatureAtPixel(evt.pixel, (feature: any) => {
            if (uploadHit) return;
            for (const managed of uploadLayers) {
              const src = (managed.layer as any).getSource?.();
              if (src && src.getFeatures().includes(feature)) {
                uploadHit = true;
                const props = feature.getProperties();
                const geom = feature.getGeometry();
                if (geom && highlightLayer) {
                  const hl = highlightLayer.getSource();
                  if (hl) {
                    const ng = createHighlightGeometry(geom);
                    if (ng) hl.addFeature(new Feature({ geometry: ng }));
                  }
                }
                const px = evt.originalEvent;
                const [lon, lat] = transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
                setPopupProperties(props);
                setPopupPosition({ x: px.offsetX, y: px.offsetY });
                setPopupGeometry(geom || null);
                setPopupCoordinates({ lon, lat });
                return;
              }
            }
          }, { hitTolerance: 8 });
          if (uploadHit) return;
        }
      }

      // FGB click
      const visibleFgbLayers = getVisibleClickableFgbLayers();
      if (visibleFgbLayers.length > 0) {
        let clicked: any = null;
        map.forEachFeatureAtPixel(
          evt.pixel,
          (feature: any) => {
            const clusterMembers = feature.get?.('features');
            if (Array.isArray(clusterMembers) && clusterMembers.length >= MIN_CLUSTER_SIZE) {
              const extent = clusterMembers.reduce(
                (acc: [number, number, number, number], member: any) => {
                  const e = member.getGeometry()?.getExtent?.();
                  if (!e) return acc;
                  return [
                    Math.min(acc[0], e[0]),
                    Math.min(acc[1], e[1]),
                    Math.max(acc[2], e[2]),
                    Math.max(acc[3], e[3]),
                  ];
                },
                [Infinity, Infinity, -Infinity, -Infinity],
              );
              if (Number.isFinite(extent[0])) {
                map.getView().fit(extent, {
                  duration: 250,
                  padding: [40, 40, 40, 40],
                  maxZoom: Math.max((map.getView().getZoom() ?? 3) + 2, 10),
                });
              }
              return true;
            }
            if (Array.isArray(clusterMembers) && clusterMembers.length >= 1) {
              clicked = clusterMembers[0] as Feature<Geometry>;
              return true;
            }
            clicked = feature as Feature<Geometry>;
            return true;
          },
          {
            hitTolerance: 6,
            layerFilter: (layer) => isClickableFgbLayer(layer),
          },
        );
        if (clicked) {
          const props = clicked.getProperties();
          const geom = clicked.getGeometry();
          if (geom && highlightLayer) {
            const hl = highlightLayer.getSource();
            if (hl) { const ng = createHighlightGeometry(geom); if (ng) hl.addFeature(new Feature({ geometry: ng })); }
          }
          const px = evt.originalEvent;
          const [lon, lat] = transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
          setPopupProperties(props);
          setPopupPosition({ x: px.offsetX, y: px.offsetY });
          setPopupGeometry(geom || null);
          setPopupCoordinates({ lon, lat });
          return;
        }
      }

      setPopupProperties(null); setPopupPosition(null); setPopupGeometry(null); setPopupCoordinates(null);
    };

    // Throttled pointer move for FGB hover
    let lastCheck = 0, lastCursor: string | null = null, lastHovered: Feature<Geometry> | null = null, pending: number | null = null;

    const detect = (evt: any) => {
      const visibleFgbLayers = getVisibleClickableFgbLayers();
      if (visibleFgbLayers.length === 0 || !highlightLayer) return;
      const view = map.getView();
      const viewZoom = view.getZoom() ?? 0;
      const estimatedFeatureCount = useMapStore.getState().fgbInfo?.featureCount ?? 0;
      if (view.getInteracting() || view.getAnimating()) {
        const el = map.getTargetElement();
        if (el && el.style.cursor !== '') el.style.cursor = '';
        highlightLayer.getSource()?.clear();
        lastHovered = null;
        lastCursor = '';
        return;
      }
      if ((estimatedFeatureCount > 100000 && viewZoom < 8) || (estimatedFeatureCount > 50000 && viewZoom < 6)) {
        const el = map.getTargetElement();
        if (el && el.style.cursor !== '') el.style.cursor = '';
        highlightLayer.getSource()?.clear();
        lastHovered = null;
        lastCursor = '';
        return;
      }
      if (useMapStore.getState().inspectMode && !useMapStore.getState().drawingActive) {
        const el = map.getTargetElement(); if (el) el.style.cursor = 'crosshair'; lastCursor = 'crosshair'; return;
      }
      lastCheck = Date.now(); pending = null;
      let hovered: any = null;
      map.forEachFeatureAtPixel(
        evt.pixel,
        (feature: any) => {
          const clusterMembers = feature.get?.('features');
          if (Array.isArray(clusterMembers) && clusterMembers.length >= MIN_CLUSTER_SIZE) return false;
          if (Array.isArray(clusterMembers) && clusterMembers.length >= 1) {
            hovered = clusterMembers[0] as Feature<Geometry>;
            return true;
          }
          hovered = feature as Feature<Geometry>;
          return true;
        },
        {
          hitTolerance: 4,
          layerFilter: (layer) => isClickableFgbLayer(layer),
        },
      );
      const cursor = hovered ? 'pointer' : '';
      if (cursor !== lastCursor) { map.getTargetElement().style.cursor = cursor; lastCursor = cursor; }
      const hs = highlightLayer.getSource();
      if (hs && hovered !== lastHovered) {
        hs.clear(); lastHovered = hovered;
        if (hovered && estimatedFeatureCount <= 50000) {
          const g = hovered.getGeometry();
          if (g) {
            const ng = createHighlightGeometry(g);
            if (ng) hs.addFeature(new Feature({ geometry: ng }));
          }
        }
      }
    };

    const onPointerMove = (evt: any) => {
      const state = useMapStore.getState();
      if (getVisibleClickableFgbLayers().length === 0) return;
      const count = state.fgbInfo?.featureCount ?? 0;
      const minInterval = count > 100000 ? 140 : count > 50000 ? 90 : 50;
      if (Date.now() - lastCheck < minInterval) {
        if (pending !== null) cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => { if (Date.now() - lastCheck >= minInterval) detect(evt); });
        return;
      }
      detect(evt);
    };

    const onLeave = () => {
      const im = useMapStore.getState().inspectMode, dr = useMapStore.getState().drawingActive;
      if (highlightLayer && !(im && !dr)) { highlightLayer.getSource()?.clear(); lastHovered = null; }
      const el = map.getTargetElement();
      if (el) { el.style.cursor = (im && !dr) ? 'crosshair' : ''; lastCursor = el.style.cursor; }
    };

    map.on('click', handleClick);
    map.on('pointermove', onPointerMove);
    const vp = map.getViewport();
    vp?.addEventListener('mouseleave', onLeave);

    return () => {
      map.un('click', handleClick); map.un('pointermove', onPointerMove);
      vp?.removeEventListener('mouseleave', onLeave);
      if (map.getTargetElement()) map.getTargetElement().style.cursor = '';
      highlightLayer?.getSource()?.clear();
    };
  }, [map, fgbLayer, highlightLayer, createHighlightGeometry, setInspectPinAtCoordinate, diversityHeightBinM]);

  const closeGediPopup = useCallback(() => {
    if (highlightedGediRef.current) {
      highlightedGediRef.current.setStyle(undefined);
      highlightedGediRef.current = null;
    }
    setGediPointPopup(null);
  }, []);

  return { gediPointPopup, closeGediPopup, clearInspectPin, clearInspectLine };
}
