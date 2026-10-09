import { useCallback, useEffect, useRef, useState } from 'react';
import { Marker, type MapMouseEvent, type PointLike } from 'maplibre-gl';
import { useMapStore } from '../stores/mapStore';
import { inspectPointAtLonLat } from '../utils/inspectPoint';
import { fetchVerticalProfile, fetchVerticalProfileLine } from '../utils/verticalProfile';
import type { GediPointData } from '../components/GediPointPopup';
import type { SavedMapFeatureGeometry } from '../stores/mapStore';
import { SELECTIVE_LOGGING_LAYER_ID } from '../utils/selectiveLogging';
import { VectorLayer, type AppFeature, type FeatureStyle, type Hit } from '../map/vector';
import { startDraw, type DrawHandle } from '../map/draw';
import { bboxToMercator, featuresBBox, geometryBBox, type BBox, type LonLat } from '../map/proj';
import type { ManagedLayer } from '../utils/LayerManager';

const MIN_CLUSTER_SIZE = 20;

const BLUE_VERTEX: FeatureStyle = { circle: { radius: 6, fill: '#1976d2', stroke: '#ffffff', strokeWidth: 2 } };

/** The vector layer a managed layer holds, if it holds one. */
function vectorOf(managed: ManagedLayer | undefined): VectorLayer | null {
  return managed?.layer instanceof VectorLayer ? managed.layer : null;
}

/** The first feature hit, in a list of layers tried in order. */
function firstHit(layers: ManagedLayer[], point: PointLike, tolerance: number): { managed: ManagedLayer; hit: Hit } | null {
  for (const managed of layers) {
    const vl = vectorOf(managed);
    if (!vl) continue;
    const hit = vl.hitTest(point, tolerance)[0];
    if (hit) return { managed, hit };
  }
  return null;
}

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
  const inspectPinLayerRef = useRef<VectorLayer | null>(null);
  const drawLayerRef = useRef<VectorLayer | null>(null);
  const labelLayerRef = useRef<VectorLayer | null>(null);
  const inspectLineLayerRef = useRef<VectorLayer | null>(null);
  const highlightedGediRef = useRef<{ layer: VectorLayer; feature: AppFeature } | null>(null);
  const [gediPointPopup, setGediPointPopup] = useState<GediPointData | null>(null);

  const setCursor = useCallback((cursor: string) => {
    if (map) map.getCanvasContainer().style.cursor = cursor;
  }, [map]);

  const getVisibleClickableFgbLayers = (): ManagedLayer[] => {
    const manager = useMapStore.getState().layerManager;
    const managedLayers = manager
      ? manager.getLayersByType('fgb').filter((managed) => managed?.visible && managed?.layer)
      : [];
    if (managedLayers.length > 0) return managedLayers;

    // Fallback for moments where layer manager hasn't registered yet.
    const fallbackFgb = useMapStore.getState().fgbLayer;
    return fallbackFgb && fallbackFgb.getVisible()
      ? [{ id: 'fgb', name: '', type: 'fgb', layer: fallbackFgb, visible: true, opacity: 1, zIndex: fallbackFgb.getZIndex() }]
      : [];
  };

  const clearInspectPin = useCallback(() => {
    inspectPinLayerRef.current?.clear();
  }, []);

  const clearInspectLine = useCallback(() => {
    useMapStore.getState().setTransectHeatmapSampleIndex(null);
    if (inspectLineLayerRef.current) {
      inspectLineLayerRef.current.detach();
      inspectLineLayerRef.current = null;
    }
  }, []);

  const setInspectPinAt = useCallback((lonLat: LonLat) => {
    inspectPinLayerRef.current?.setFeatures([
      { type: 'Feature', geometry: { type: 'Point', coordinates: lonLat }, properties: {} },
    ]);
  }, []);

  /** Draw a geometry in the highlight layer, replacing what was there. */
  const highlightGeometry = useCallback((geometry: GeoJSON.Geometry | null) => {
    const hl = useMapStore.getState().highlightLayer;
    if (!hl) return;
    hl.setFeatures(geometry ? [{ type: 'Feature', geometry, properties: {} }] : []);
  }, []);

  // Inspect pin layer
  useEffect(() => {
    if (!map) return;
    const layer = new VectorLayer({
      zIndex: 1200,
      style: { circle: { radius: 6, fill: '#d32f2f', stroke: '#ffffff', strokeWidth: 2 } },
    });
    layer.attach(map);
    inspectPinLayerRef.current = layer;
    return () => { layer.detach(); inspectPinLayerRef.current = null; };
  }, [map]);

  // Cursor for inspect mode
  useEffect(() => {
    if (!map) return;
    const { inspectMode, drawingActive: da } = useMapStore.getState();
    if (inspectMode && !da) setCursor('crosshair');
    else if (!da) setCursor('');
  }, [map, setCursor, useMapStore.getState().inspectMode, drawingActive]);

  useEffect(() => { if (!useMapStore.getState().inspectMode) clearInspectPin(); }, [useMapStore.getState().inspectMode, clearInspectPin]);

  // Hide all feature popups while drawing tools are active
  useEffect(() => {
    if (!drawingActive) return;
    setPopupProperties(null);
    setPopupPosition(null);
    setPopupGeometry(null);
    setPopupCoordinates(null);
    setGediPointPopup(null);
    highlightLayer?.clear();
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
      zIndex: 10000,
      style: {
        stroke: '#ff0000',
        strokeWidth: 4,
        circle: { radius: 10, stroke: '#ff0000', strokeWidth: 4, fill: 'rgba(255, 0, 0, 0.5)' },
      },
    });
    hl.attach(map);
    setHighlightLayer(hl);
    return () => { hl.detach(); };
  }, [map]);

  // Clear the persistent rectangle layer when the export extent is reset
  // (e.g. when the user locates a saved feature, or after a successful save).
  // Without this the user would see a rectangle on the map but the export
  // panel would say "Draw a rectangle first" because the state is null.
  useEffect(() => {
    if (figureSelectionExtent === null && drawLayerRef.current && map) {
      drawLayerRef.current.detach();
      drawLayerRef.current = null;
    }
  }, [figureSelectionExtent, map]);

  // Draw interaction
  useEffect(() => {
    if (!map || !drawingActive) return;
    if (drawLayerRef.current) { drawLayerRef.current.detach(); drawLayerRef.current = null; }
    if (labelLayerRef.current) { labelLayerRef.current.detach(); labelLayerRef.current = null; }

    // The drawn rectangle stays on the map after the draw ends, so the user
    // has visual confirmation of their selection extent.
    const drawLayer = new VectorLayer({
      zIndex: 9500,
      style: { stroke: 'rgba(33, 150, 243, 0.95)', strokeWidth: 2, fill: 'rgba(33, 150, 243, 0.10)' },
    });
    drawLayer.attach(map);
    drawLayerRef.current = drawLayer;

    // Shift draws a square.
    const draw: DrawHandle = startDraw(map, {
      type: 'box',
      sketch: { line: { stroke: 'rgba(33, 150, 243, 0.95)', strokeWidth: 2, fill: 'rgba(33, 150, 243, 0.10)' }, vertex: BLUE_VERTEX },
      onEnd: (geom) => {
        drawLayer.setFeatures([{ type: 'Feature', geometry: geom, properties: {} }]);
        const drawn = geometryBBox(geom) as BBox;
        if (drawingMode === 'figures' || drawingMode === 'figures_db') {
          // The backend takes the export extent in EPSG:3857.
          setFigureSelectionExtent(bboxToMercator(drawn));
        } else {
          const fgb = useMapStore.getState().fgbLayer;
          if (!fgb) { draw.stop(); setDrawingActive(false); return; }

          const tileNames: string[] = [];
          const labelFeatures: GeoJSON.Feature[] = [];
          for (const f of fgb.getFeaturesInBBox(drawn)) {
            const name = f.properties.Name;
            if (name && typeof name === 'string') {
              tileNames.push(name);
              const ext = geometryBBox(f.geometry);
              if (ext) {
                labelFeatures.push({
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2] },
                  properties: { tileName: name },
                });
              }
            }
          }
          tileNames.sort();
          setSelectedTiles(tileNames);

          if (drawLayerRef.current) { drawLayerRef.current.detach(); drawLayerRef.current = null; }
          if (labelLayerRef.current) { labelLayerRef.current.detach(); labelLayerRef.current = null; }

          const lblLayer = new VectorLayer({
            zIndex: 9001,
            style: (f) => ({ text: { value: f.properties.tileName || '', size: 16, bold: true, color: '#FFD700', halo: '#000000', haloWidth: 1.5 } }),
          });
          lblLayer.setFeatures(labelFeatures);
          lblLayer.attach(map);
          labelLayerRef.current = lblLayer;

          const mgr = useMapStore.getState().layerManager;
          const labelLayerId = `vector-tiles-${Date.now()}`;
          if (mgr) {
            mgr.addLayer(labelLayerId, `Selected Tiles (${tileNames.length})`, 'vector', lblLayer, { featureNames: tileNames });
            updateLayersList();
          }
        }

        draw.stop();
        setDrawingActive(false);
      },
    });

    return () => {
      draw.stop();
    };
  }, [map, drawingActive, drawingMode, setFigureSelectionExtent]);

  // Draw a saved feature geometry while inspect mode is active.
  useEffect(() => {
    if (!map || !inspectMode || drawingActive) return;
    if (featureCaptureType !== 'LineString' && featureCaptureType !== 'Polygon') return;

    // Shift makes a line segment horizontal.
    const draw = startDraw(map, {
      type: featureCaptureType,
      sketch: {
        line: { stroke: '#8e24aa', strokeWidth: 3, fill: 'rgba(142, 36, 170, 0.15)' },
        vertex: { circle: { radius: 5, fill: '#8e24aa', stroke: '#ffffff', strokeWidth: 1.5 } },
      },
      onEnd: (geom) => {
        let geometryPayload: SavedMapFeatureGeometry | null = null;

        if (featureCaptureType === 'LineString' && geom.type === 'LineString') {
          geometryPayload = {
            type: 'LineString',
            coordinates: geom.coordinates as [number, number][],
          };
        }
        if (featureCaptureType === 'Polygon' && geom.type === 'Polygon') {
          if (geom.coordinates.length > 0) {
            geometryPayload = {
              type: 'Polygon',
              coordinates: geom.coordinates as [number, number][][],
            };
          }
        }

        if (geometryPayload) {
          setFeatureDraft({ geometry: geometryPayload });
        }
        setFeatureCaptureType(null);
      },
    });

    return () => {
      draw.stop();
    };
  }, [map, inspectMode, drawingActive, featureCaptureType, setFeatureCaptureType, setFeatureDraft]);

  // Draw line for vertical profile transect inspect mode
  useEffect(() => {
    if (!map) return;
    if (!(inspectMode && inspectKind === 'vertical_profile_line') || drawingActive || featureCaptureType) return;

    // Create the layer only once; keep it alive across deactivations so the
    // drawn line persists until the panel is explicitly closed.
    if (!inspectLineLayerRef.current) {
      const layer = new VectorLayer({
        zIndex: 1300,
        style: (f) => {
          if (f.properties.transectHeatmapHover) {
            return { circle: { radius: 10, fill: 'rgba(255, 152, 0, 0.95)', stroke: '#ffffff', strokeWidth: 3 } };
          }
          const t = f.geometry.type;
          if (t === 'Point' || t === 'MultiPoint') return BLUE_VERTEX;
          return { stroke: '#1976d2', strokeWidth: 4 };
        },
      });
      layer.attach(map);
      inspectLineLayerRef.current = layer;
    }

    const source = inspectLineLayerRef.current;

    // Shift makes a segment horizontal.
    const draw = startDraw(map, {
      type: 'LineString',
      sketch: { line: { stroke: '#1976d2', strokeWidth: 4, dashed: true }, vertex: BLUE_VERTEX },
      onStart: () => {
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
            version: 'original',
            maxHeight: undefined,
            heatmapMaxHeight: undefined,
            fhdInterval: useMapStore.getState().diversityHeightBinM,
          },
          transectProfile: prev?.kind === 'vertical_profile_line' ? prev.transectProfile : undefined,
          inspectError: null,
        }));
      },
      onEnd: (geom) => {
        if (geom.type !== 'LineString') return;
        const lineCoordinates = geom.coordinates as [number, number][];
        if (lineCoordinates.length < 2) {
          useMapStore.getState().setInspectPanel(null);
          return;
        }
        // Replace the prior transect with this one.
        source.setFeatures([{ type: 'Feature', geometry: geom, properties: {} }]);
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
                version: data.version,
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
              version: data.version,
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
        }).catch((err) => {
          if (req !== inspectRequestIdRef.current) return;
          console.error('[vertical-profile-line] fetch failed:', err);
          useMapStore.getState().setInspectPanel({
            lon: first[0],
            lat: first[1],
            layers: [],
            loading: false,
            kind: 'vertical_profile_line',
            profileMeta: {
              tileName: '',
              year: vsmYear,
              qIndex: 1,
              version: undefined,
              maxHeight: undefined,
              heatmapMaxHeight: undefined,
              fhdInterval: diversityHeightBinM,
            },
            transectProfile: undefined,
            inspectError: `Network error: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      },
    });

    return () => {
      // Only end the drawing — keep the layer so the drawn line stays visible
      // on the map until the user explicitly closes the panel.
      draw.stop();
    };
  }, [map, clearInspectPin, inspectMode, inspectKind, drawingActive, featureCaptureType, vsmYear, diversityHeightBinM]);

  // Transect heatmap: mirror hovered/locked column as a point on the map line.
  useEffect(() => {
    const source = inspectLineLayerRef.current;
    if (!map || !source) return;

    for (const f of source.getFeatures()) {
      if (f.properties.transectHeatmapHover) source.removeFeature(f);
    }

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

    source.addFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [sample.lon, sample.lat] },
      properties: { transectHeatmapHover: true },
    });
  }, [map, transectHeatmapSampleIndex, inspectPanel?.kind, inspectPanel?.transectProfile?.samples]);

  // Hover + delete button on vector label features (skip GEDI)
  useEffect(() => {
    if (!map) return;
    const deleteEl = document.createElement('div');
    deleteEl.innerHTML = '✕';
    deleteEl.style.cssText = 'background:#ff4444;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.4);user-select:none;';
    // Up and to the right of the label it deletes.
    const marker = new Marker({ element: deleteEl, anchor: 'bottom-left', offset: [5, -5] });

    let hovered: { layer: VectorLayer; feature: AppFeature; layerId: string } | null = null;

    const unhover = () => {
      if (hovered) hovered.layer.setFeatureStyle(hovered.feature, undefined);
      hovered = null;
      marker.remove();
    };

    // The button sits on the map; a press on it is not a press on the map.
    const swallow = (e: Event) => e.stopPropagation();
    deleteEl.addEventListener('mousedown', swallow);
    deleteEl.addEventListener('dblclick', swallow);
    deleteEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hovered) return;
      const mgr = useMapStore.getState().layerManager;
      if (!mgr) return;
      const { layer, feature, layerId } = hovered;
      const managed = mgr.getLayer(layerId);
      if (!managed) return;
      const tileName = feature.properties.tileName;
      layer.removeFeature(feature);
      const tiles = useMapStore.getState().selectedTiles;
      useMapStore.getState().setSelectedTiles(tiles.filter((t: string) => t !== tileName));
      const remaining = layer.getFeatures().length;
      if (remaining === 0) mgr.removeLayer(layerId);
      else managed.name = `Selected Tiles (${remaining})`;
      updateLayersList();
      hovered = null;
      marker.remove();
    });

    const onMouseMove = (e: MapMouseEvent) => {
      if (map.isMoving()) return;
      const mgr = useMapStore.getState().layerManager;
      if (!mgr) return;
      const vectorLayers = mgr.getLayersByType('vector').filter((m) => !m.id.startsWith('gedi-'));
      if (vectorLayers.length === 0) {
        unhover();
        return;
      }
      const found = firstHit(vectorLayers, e.point, 10);
      if (!found || found.hit.kind !== 'feature') {
        unhover();
        return;
      }
      const feature = found.hit.feature;
      const layer = vectorOf(found.managed)!;
      if (hovered?.feature === feature) return;
      unhover();
      layer.setFeatureStyle(feature, {
        text: { value: feature.properties.tileName || '', size: 22, bold: true, color: '#FFFFFF', halo: '#FF0000', haloWidth: 2 },
      });
      hovered = { layer, feature, layerId: found.managed.id };
      if (feature.geometry.type === 'Point') marker.setLngLat(feature.geometry.coordinates as LonLat).addTo(map);
    };

    map.on('mousemove', onMouseMove);
    return () => {
      map.off('mousemove', onMouseMove);
      unhover();
      deleteEl.remove();
    };
  }, [map, updateLayersList]);

  // Click + pointer move for FGB features and GEDI points
  useEffect(() => {
    if (!map || !highlightLayer) return;

    const showPopup = (feature: AppFeature, e: MapMouseEvent) => {
      highlightGeometry(feature.geometry);
      setPopupProperties(feature.properties);
      setPopupPosition({ x: e.point.x, y: e.point.y });
      setPopupGeometry(feature.geometry);
      setPopupCoordinates({ lon: e.lngLat.lng, lat: e.lngLat.lat });
    };

    const handleClick = (e: MapMouseEvent) => {
      const { inspectMode: im, drawingActive: drawOn } = useMapStore.getState();
      const mgr = useMapStore.getState().layerManager;
      const { lng: lon, lat } = e.lngLat;
      if (drawOn) {
        setPopupProperties(null);
        setPopupPosition(null);
        setPopupGeometry(null);
        setPopupCoordinates(null);
        setGediPointPopup(null);
        highlightLayer.clear();
        return;
      }

      if (im && !drawOn) {
        if (useMapStore.getState().featureCaptureType === 'Point') {
          setInspectPinAt([lon, lat]);
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

        setInspectPinAt([lon, lat]);
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
                version: data.version,
                maxHeight: data.max_height,
                heatmapMaxHeight: data.heatmap_max_height,
                profileYMin: data.profile_y_min,
                profileYMax: data.profile_y_max,
                fhdInterval: data.fhd_interval ?? diversityHeightBinM,
              },
              pendingSample: undefined, inspectError: null,
            });
          }).catch((err) => {
            if (req !== inspectRequestIdRef.current) return;
            console.error('[vertical-profile] fetch failed:', err);
            useMapStore.getState().setInspectPanel((prev) => ({
              lon, lat, layers: [], loading: false, kind: 'vertical_profile' as const,
              verticalProfile: prev?.verticalProfile, verticalProfileCurve: prev?.verticalProfileCurve,
              profileMetrics: prev?.profileMetrics,
              profileMeta: prev?.profileMeta, pendingSample: undefined,
              inspectError: `Network error: ${err instanceof Error ? err.message : String(err)}`,
            }));
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

      highlightLayer.clear();

      // GEDI click
      if (highlightedGediRef.current) {
        highlightedGediRef.current.layer.setFeatureStyle(highlightedGediRef.current.feature, undefined);
        highlightedGediRef.current = null;
      }
      if (mgr) {
        const gediLayers = mgr.getLayersByType('vector').filter((m) => m.id.startsWith('gedi-'));
        const found = firstHit(gediLayers, e.point, 6);
        if (found && found.hit.kind === 'feature') {
          const { feature } = found.hit;
          const layer = vectorOf(found.managed)!;
          layer.setFeatureStyle(feature, {
            circle: { radius: 8, fill: 'rgba(255, 235, 59, 0.9)', stroke: '#e65100', strokeWidth: 2.5 },
          });
          highlightedGediRef.current = { layer, feature };
          const featureCoord = feature.geometry.type === 'Point' ? feature.geometry.coordinates : [lon, lat];
          setGediPointPopup({ coordinate: featureCoord, properties: feature.properties });
          return;
        }
      }
      setGediPointPopup(null);

      // Uploaded vector layer click
      if (mgr) {
        const uploadLayers = mgr.getLayersByType('vector').filter((m) => m.id.startsWith('upload-') || m.id === SELECTIVE_LOGGING_LAYER_ID);
        const found = firstHit(uploadLayers, e.point, 8);
        if (found && found.hit.kind === 'feature') {
          showPopup(found.hit.feature, e);
          return;
        }
      }

      // FGB click
      const visibleFgbLayers = getVisibleClickableFgbLayers();
      if (visibleFgbLayers.length > 0) {
        const found = firstHit(visibleFgbLayers, e.point, 6);
        if (found) {
          const layer = vectorOf(found.managed)!;
          const { hit } = found;
          if (hit.kind === 'feature') {
            showPopup(hit.feature, e);
            return;
          }
          // A cluster: zoom into a large one, open the first member of a small one.
          layer.clusterLeaves(hit.clusterId).then((leaves) => {
            if (hit.count >= MIN_CLUSTER_SIZE) {
              const extent = featuresBBox(leaves);
              if (extent) {
                map.fitBounds(extent, {
                  duration: 250,
                  padding: 40,
                  // MapLibre zoom: OpenLayers' 10, less one.
                  maxZoom: Math.max(map.getZoom() + 2, 9),
                });
              }
              return;
            }
            const fid = leaves[0]?.properties?._fid as number | undefined;
            const member = fid !== undefined ? layer.getFeatureById(fid) : undefined;
            if (member) showPopup(member, e);
          });
          return;
        }
      }

      setPopupProperties(null); setPopupPosition(null); setPopupGeometry(null); setPopupCoordinates(null);
    };

    // Throttled pointer move for FGB hover
    let lastCheck = 0, lastCursor: string | null = null, lastHovered: AppFeature | null = null, pending: number | null = null;

    const detect = (e: MapMouseEvent) => {
      const visibleFgbLayers = getVisibleClickableFgbLayers();
      if (visibleFgbLayers.length === 0 || !highlightLayer) return;
      const viewZoom = map.getZoom();
      const estimatedFeatureCount = useMapStore.getState().fgbInfo?.featureCount ?? 0;
      if (map.isMoving()) {
        if (lastCursor !== '') setCursor('');
        highlightLayer.clear();
        lastHovered = null;
        lastCursor = '';
        return;
      }
      // MapLibre zooms: OpenLayers' 8 and 6, less one.
      if ((estimatedFeatureCount > 100000 && viewZoom < 7) || (estimatedFeatureCount > 50000 && viewZoom < 5)) {
        if (lastCursor !== '') setCursor('');
        highlightLayer.clear();
        lastHovered = null;
        lastCursor = '';
        return;
      }
      if (useMapStore.getState().inspectMode && !useMapStore.getState().drawingActive) {
        setCursor('crosshair'); lastCursor = 'crosshair'; return;
      }
      lastCheck = Date.now(); pending = null;
      // Large clusters are for zooming into, not hovering.
      const found = firstHit(visibleFgbLayers, e.point, 4);
      const hovered = found?.hit.kind === 'feature' ? found.hit.feature : null;
      const pointable = hovered !== null || (found?.hit.kind === 'cluster' && found.hit.count < MIN_CLUSTER_SIZE);
      const cursor = pointable ? 'pointer' : '';
      if (cursor !== lastCursor) { setCursor(cursor); lastCursor = cursor; }
      if (hovered !== lastHovered) {
        lastHovered = hovered;
        highlightGeometry(hovered && estimatedFeatureCount <= 50000 ? hovered.geometry : null);
      }
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const state = useMapStore.getState();
      if (getVisibleClickableFgbLayers().length === 0) return;
      const count = state.fgbInfo?.featureCount ?? 0;
      const minInterval = count > 100000 ? 140 : count > 50000 ? 90 : 50;
      if (Date.now() - lastCheck < minInterval) {
        if (pending !== null) cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => { if (Date.now() - lastCheck >= minInterval) detect(e); });
        return;
      }
      detect(e);
    };

    const onLeave = () => {
      const im = useMapStore.getState().inspectMode, dr = useMapStore.getState().drawingActive;
      if (highlightLayer && !(im && !dr)) { highlightLayer.clear(); lastHovered = null; }
      const cursor = (im && !dr) ? 'crosshair' : '';
      setCursor(cursor);
      lastCursor = cursor;
    };

    map.on('click', handleClick);
    map.on('mousemove', onMouseMove);
    map.on('mouseout', onLeave);

    return () => {
      map.off('click', handleClick); map.off('mousemove', onMouseMove);
      map.off('mouseout', onLeave);
      if (pending !== null) cancelAnimationFrame(pending);
      setCursor('');
      highlightLayer?.clear();
    };
  }, [map, fgbLayer, highlightLayer, highlightGeometry, setCursor, setInspectPinAt, diversityHeightBinM]);

  const closeGediPopup = useCallback(() => {
    if (highlightedGediRef.current) {
      highlightedGediRef.current.layer.setFeatureStyle(highlightedGediRef.current.feature, undefined);
      highlightedGediRef.current = null;
    }
    setGediPointPopup(null);
  }, []);

  return { gediPointPopup, closeGediPopup, clearInspectPin, clearInspectLine };
}
