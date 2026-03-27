import { useCallback, useEffect, useRef, useState } from 'react';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Feature } from 'ol';
import { Geometry, Point, Polygon, LineString, MultiPolygon, MultiLineString } from 'ol/geom';
import { Style, Stroke, Fill, Circle as CircleStyle, Text as TextStyle } from 'ol/style';
import Draw, { createBox } from 'ol/interaction/Draw';
import { transform } from 'ol/proj';
import { useMapStore } from '../stores/mapStore';
import { inspectPointAtLonLat } from '../utils/inspectPoint';
import { fetchVerticalProfile } from '../utils/verticalProfile';
import type { GediPointData } from '../components/GediPointPopup';

export function useMapInteractions(updateLayersList: () => void) {
  const {
    map, fgbLayer, highlightLayer, setHighlightLayer,
    setPopupProperties, setPopupPosition, setPopupGeometry, setPopupCoordinates,
    setInspectPanel,
  } = useMapStore();
  const { drawingActive, setDrawingActive, setSelectedTiles } = useMapStore();

  const inspectRequestIdRef = useRef(0);
  const inspectPinLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const inspectPinFeatureRef = useRef<Feature<Point> | null>(null);
  const drawLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const labelLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const [gediPointPopup, setGediPointPopup] = useState<GediPointData | null>(null);

  const clearInspectPin = useCallback(() => {
    inspectPinLayerRef.current?.getSource()?.clear();
    inspectPinFeatureRef.current = null;
  }, []);

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

  // Draw interaction
  useEffect(() => {
    if (!map || !drawingActive) return;
    if (drawLayerRef.current) { map.removeLayer(drawLayerRef.current); drawLayerRef.current = null; }
    if (labelLayerRef.current) { map.removeLayer(labelLayerRef.current); labelLayerRef.current = null; }

    const drawSource = new VectorSource();
    const drawInteraction = new Draw({ source: drawSource, type: 'Circle', geometryFunction: createBox() });
    map.addInteraction(drawInteraction);
    const mapEl = map.getTargetElement();
    if (mapEl) mapEl.style.cursor = 'crosshair';

    drawInteraction.on('drawend', (event: any) => {
      const geom = event.feature.getGeometry();
      if (!geom) return;
      const drawnExtent = geom.getExtent();
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

      map.removeInteraction(drawInteraction);
      if (mapEl) mapEl.style.cursor = '';
      setDrawingActive(false);
    });

    return () => {
      map.removeInteraction(drawInteraction);
      const el = map.getTargetElement();
      if (el) el.style.cursor = '';
    };
  }, [map, drawingActive]);

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

      if (im && !drawOn) {
        setInspectPinAtCoordinate(evt.coordinate);
        const [lon, lat] = transform(evt.coordinate, 'EPSG:3857', 'EPSG:4326');
        const req = ++inspectRequestIdRef.current;
        const { inspectKind, vsmYear } = useMapStore.getState();

        if (inspectKind === 'vertical_profile') {
          useMapStore.getState().setInspectPanel((prev) => {
            const stale = prev?.kind === 'vertical_profile' && prev.verticalProfile?.length;
            return stale
              ? { ...prev!, loading: true, pendingSample: { lon, lat } }
              : { lon, lat, layers: [], loading: true, kind: 'vertical_profile', pendingSample: undefined, inspectError: null };
          });
          fetchVerticalProfile(lon, lat, vsmYear).then((data) => {
            if (req !== inspectRequestIdRef.current) return;
            if (!data.success || !data.profile) {
              useMapStore.getState().setInspectPanel((prev) => ({
                lon, lat, layers: [], loading: false, kind: 'vertical_profile' as const,
                verticalProfile: prev?.verticalProfile, verticalProfileCurve: prev?.verticalProfileCurve,
                profileMeta: prev?.profileMeta, pendingSample: undefined, inspectError: data.error || 'Failed',
              }));
              return;
            }
            useMapStore.getState().setInspectPanel({
              lon, lat, layers: [], loading: false, kind: 'vertical_profile',
              verticalProfile: data.profile, verticalProfileCurve: data.vertical_profile_curve,
              profileMeta: { tileName: data.tile_name || '', year: data.year ?? vsmYear, qIndex: data.q_index ?? 1, source: data.source },
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
              setGediPointPopup({ coordinate: evt.coordinate, properties: feature.getProperties() });
              return;
            }
          }
        }, { hitTolerance: 6 });
        if (hit) return;
      }
      setGediPointPopup(null);

      // FGB click
      const currentFgb = useMapStore.getState().fgbLayer;
      if (currentFgb) {
        const source = currentFgb.getSource();
        const hits = source ? source.getFeaturesAtCoordinate(evt.coordinate) : [];
        const clicked = (hits[0] as Feature<Geometry>) ?? null;
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
      const currentFgb = useMapStore.getState().fgbLayer;
      if (!currentFgb || !highlightLayer) return;
      if (useMapStore.getState().inspectMode && !useMapStore.getState().drawingActive) {
        const el = map.getTargetElement(); if (el) el.style.cursor = 'crosshair'; lastCursor = 'crosshair'; return;
      }
      lastCheck = Date.now(); pending = null;
      const source = currentFgb.getSource();
      const hits = source ? source.getFeaturesAtCoordinate(evt.coordinate) : [];
      const hovered = (hits[0] as Feature<Geometry>) ?? null;
      const cursor = hovered ? 'pointer' : '';
      if (cursor !== lastCursor) { map.getTargetElement().style.cursor = cursor; lastCursor = cursor; }
      const hs = highlightLayer.getSource();
      if (hs && hovered !== lastHovered) {
        hs.clear(); lastHovered = hovered;
        if (hovered) { const g = hovered.getGeometry(); if (g) { const ng = createHighlightGeometry(g); if (ng) hs.addFeature(new Feature({ geometry: ng })); } }
      }
    };

    const onPointerMove = (evt: any) => {
      if (!useMapStore.getState().fgbLayer) return;
      if (Date.now() - lastCheck < 50) {
        if (pending !== null) cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => { if (Date.now() - lastCheck >= 50) detect(evt); });
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
  }, [map, fgbLayer, highlightLayer, createHighlightGeometry, setInspectPinAtCoordinate]);

  return { gediPointPopup, setGediPointPopup, clearInspectPin };
}
