import React, { useCallback, useEffect } from 'react';
import './App.css';
import { MapComponent, type Map } from './components/Map';
import { SidebarContainer } from './containers/SidebarContainer';
import { ThemeProvider, createTheme, CssBaseline, Snackbar, Alert } from '@mui/material';
import { LayerControl } from './components/LayerControl';
import { FeaturePopup } from './components/FeaturePopup';
import { TileSearch } from './components/TileSearch';
import { BaseMapSelector } from './components/BaseMapSelector';
import { MapColorbarOverlay } from './components/MapColorbarOverlay';
import { EarthEngineLegendOverlay } from './components/EarthEngineLegendOverlay';
import { NaturalnessLegendOverlay } from './components/NaturalnessLegendOverlay';
import { GediPointPopup } from './components/GediPointPopup';
import { LayerManager } from './utils/LayerManager';
import { useMapStore } from './stores/mapStore';
import { InspectPanel } from './components/InspectPanel';
import { SavedGediPointsList } from './components/SavedGediPointsList';
import { SavedFeatureDialog, type SavedFeatureDialogPrefill } from './components/SavedFeatureDialog';
import {
  createSavedFeature,
  listSavedFeatureTags,
  lookupSavedFeatureByGeometry,
} from './services/savedFeaturesApi';

import { useLayerLoaders } from './hooks/useLayerLoaders';
import { useAutoLoadVSM } from './hooks/useAutoLoadVSM';
import { useMapInteractions } from './hooks/useMapInteractions';
import { useLayerControls } from './hooks/useLayerControls';
const theme = createTheme({ palette: { mode: 'light', primary: { main: '#1976d2' } } });

function App() {
  const {
    map, setMap, cogLayer, fgbLayer,
    layers, setLayers, popupProperties, popupPosition, popupGeometry, popupCoordinates,
    layerManager, setLayerManager, closePopup, inspectPanel, setInspectPanel,
    featureDraft, setFeatureDraft, addSavedMapFeature, setFeatureCaptureType, savedMapFeatures,
  } = useMapStore();
  const [savingFeature, setSavingFeature] = React.useState(false);
  const [saveFeatureError, setSaveFeatureError] = React.useState<string | null>(null);
  const [saveSuccessOpen, setSaveSuccessOpen] = React.useState(false);
  const [saveSuccessName, setSaveSuccessName] = React.useState('');
  const [existingTags, setExistingTags] = React.useState<string[]>([]);
  const [dialogPrefill, setDialogPrefill] = React.useState<SavedFeatureDialogPrefill | null>(null);

  useEffect(() => {
    if (featureDraft) {
      setSaveFeatureError(null);
    } else {
      // Closing the dialog discards any prefill — the next save starts fresh.
      setDialogPrefill(null);
    }
  }, [featureDraft]);

  // Look up an existing save of the same geometry and refresh the tag-suggestion
  // list each time the dialog is about to open. Best-effort: if either request
  // fails the dialog still opens empty.
  useEffect(() => {
    if (!featureDraft) return;
    let cancelled = false;
    (async () => {
      try {
        const [lookup, tags] = await Promise.all([
          lookupSavedFeatureByGeometry(featureDraft.geometry),
          listSavedFeatureTags(),
        ]);
        if (cancelled) return;
        setExistingTags(tags);
        if (lookup.feature) {
          const existing = lookup.feature;
          setDialogPrefill({
            name: existing.name,
            description: existing.description ?? '',
            category: existing.category ?? '',
            tags: Array.isArray(existing.metadata?.tags) ? existing.metadata!.tags : [],
            fromExistingId: existing.id,
          });
        } else {
          setDialogPrefill(null);
        }
      } catch {
        // Network / 5xx: leave dialog empty rather than blocking the save.
        if (!cancelled) setDialogPrefill(null);
      }
    })();
    return () => { cancelled = true; };
  }, [featureDraft]);

  // Initialize layer manager
  useEffect(() => {
    if (!layerManager) {
      const manager = new LayerManager(null);
      setLayerManager(manager);
      const currentMap = useMapStore.getState().map;
      if (currentMap) manager.setMap(currentMap);
    }
  }, [layerManager, setLayerManager]);

  const handleMapInit = useCallback((mapInstance: Map) => {
    setMap(mapInstance);
    const mgr = useMapStore.getState().layerManager;
    if (mgr) mgr.setMap(mapInstance);
    else setLayerManager(new LayerManager(mapInstance));
  }, [setMap, setLayerManager]);

  const updateLayersList = useCallback(() => {
    if (!map || !layerManager) return;
    layerManager.syncAllProperties();
    const managedLayers = layerManager.getAllLayers();
    setLayers(managedLayers.map((m: any) => ({
      id: m.id, name: m.name, visible: m.visible, opacity: m.opacity,
      zIndex: m.zIndex, type: m.type, metadata: m.metadata,
    })));
  }, [map, layerManager]);

  // Register COG layer with LayerManager
  useEffect(() => {
    if (!layerManager) return;
    if (cogLayer && map) {
      const metadata: any = {};
      const ext = cogLayer.getExtent();
      if (ext?.length === 4) metadata.extent = ext;
      layerManager.addLayer('cog', 'GeoTIFF Layer', 'cog', cogLayer, metadata);
      updateLayersList();
    } else if (!cogLayer) { layerManager.removeLayer('cog'); updateLayersList(); }
  }, [cogLayer, map, layerManager, updateLayersList]);

  // Register FGB layer with LayerManager
  useEffect(() => {
    if (!layerManager) return;
    if (fgbLayer && map) {
      const metadata: any = {};
      try {
        const src = fgbLayer.getSource();
        if (src && typeof src.getExtent === 'function') {
          const ext = src.getExtent();
          if (ext?.length === 4) metadata.extent = ext;
        }
      } catch { /* ignore */ }
      const datasetKind = fgbLayer.get('datasetKind');
      const datasetDisplayName = fgbLayer.get('datasetDisplayName');
      const layerId =
        datasetKind === 'sentinel2-grid'
          ? 'fgb-sentinel2-grid'
          : datasetKind === 'naturalness'
            ? 'fgb-naturalness'
            : datasetKind === 'naturalness-val'
              ? 'fgb-naturalness-val'
              : 'fgb';
      const layerName = typeof datasetDisplayName === 'string' && datasetDisplayName
        ? datasetDisplayName
        : 'FlatGeobuf Layer';
      metadata.datasetKind = datasetKind;
      layerManager.addLayer(layerId, layerName, 'fgb', fgbLayer, metadata);
      updateLayersList();
    } else if (!fgbLayer) {
      layerManager.removeLayer('fgb');
      layerManager.removeLayer('fgb-sentinel2-grid');
      layerManager.removeLayer('fgb-naturalness');
      layerManager.removeLayer('fgb-naturalness-val');
      updateLayersList();
    }
  }, [fgbLayer, map, layerManager, updateLayersList]);

  React.useEffect(() => { updateLayersList(); }, [updateLayersList]);

  // Hooks
  const { handleLoadSentinel2Image, handleLoadPredictionCOG, handleLoadAuxiliaryLayer, handleLoadGEDIPoints } = useLayerLoaders(updateLayersList);
  const { showZoomMessage, globalLayersRef } = useAutoLoadVSM(updateLayersList);
  const { gediPointPopup, closeGediPopup, clearInspectPin, clearInspectLine } = useMapInteractions(updateLayersList);
  const {
    handleToggleVisibility, handleChangeOpacity, handleChangeZIndex,
    handleChangePredictionRescale, handleChangePredictionColormap, handleChangeDiversityBandConfig,
    handleReorderLayers, handleRemoveLayer,
    handleLocateLayer, vectorFeatures, handleHighlightFeature, handleRemoveFeature,
  } = useLayerControls(updateLayersList, globalLayersRef);

  const handleCancelFeatureDraft = useCallback(() => {
    setSaveFeatureError(null);
    setFeatureDraft(null);
    setFeatureCaptureType(null);
  }, [setFeatureDraft, setFeatureCaptureType]);

  const handleSaveFeatureDraft = useCallback(async (payload: { name: string; description: string; category: string; tags: string[] }) => {
    if (!featureDraft) return;
    setSaveFeatureError(null);
    setSavingFeature(true);
    try {
      const saved = await createSavedFeature({
        name: payload.name,
        category: payload.category || undefined,
        description: payload.description || undefined,
        tags: payload.tags.length > 0 ? payload.tags : undefined,
        geometry: featureDraft.geometry,
        metadata: featureDraft.metadata,
        plot_data: featureDraft.plot_data,
      });
      addSavedMapFeature(saved);
      setSaveSuccessName(saved.name);
      setSaveSuccessOpen(true);
      setFeatureDraft(null);
      setFeatureCaptureType(null);
    } catch (error) {
      setSaveFeatureError(error instanceof Error ? error.message : 'Failed to save feature');
    } finally {
      setSavingFeature(false);
    }
  }, [featureDraft, addSavedMapFeature, setFeatureDraft, setFeatureCaptureType]);

  const existingCategories = React.useMemo(() => {
    const features = Array.isArray(savedMapFeatures) ? savedMapFeatures : [];
    return Array.from(
      new Set(
        features
          .map((feature) => feature.category?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort();
  }, [savedMapFeatures]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
        <SidebarContainer />
        <LayerControl
          layers={layers}
          onToggleVisibility={handleToggleVisibility}
          onChangeOpacity={handleChangeOpacity}
          onChangeZIndex={handleChangeZIndex}
          onReorderLayers={handleReorderLayers}
          onRemoveLayer={handleRemoveLayer}
          onLocateLayer={handleLocateLayer}
          onChangePredictionRescale={handleChangePredictionRescale}
          onChangePredictionColormap={handleChangePredictionColormap}
          onChangeDiversityBandConfig={handleChangeDiversityBandConfig}
          onHighlightFeature={handleHighlightFeature}
          onRemoveFeature={handleRemoveFeature}
          vectorFeatures={vectorFeatures}
        />
        <MapComponent onMapInit={handleMapInit} />

        {showZoomMessage && (
          <div style={{
            position: 'absolute', top: 75, left: '50%', transform: 'translateX(-50%)',
            zIndex: 1000, backgroundColor: 'rgba(25, 118, 210, 0.9)', color: '#fff',
            padding: '6px 20px', borderRadius: 20, fontSize: '0.85rem', fontWeight: 500,
            pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', whiteSpace: 'nowrap',
          }}>
            Zoom in to see the predictions
          </div>
        )}

        <TileSearch map={map} />
        <MapColorbarOverlay layers={layers} />
        <EarthEngineLegendOverlay layers={layers} />
        <NaturalnessLegendOverlay layers={layers} />

        {gediPointPopup && (
          <GediPointPopup data={gediPointPopup} onClose={closeGediPopup} />
        )}

        <BaseMapSelector map={map} />

        <FeaturePopup
          properties={popupProperties}
          position={popupPosition}
          geometry={popupGeometry}
          coordinates={popupCoordinates}
          onLoadSentinel2Image={handleLoadSentinel2Image}
          onLoadPredictionCOG={handleLoadPredictionCOG}
          onLoadAuxiliaryLayer={handleLoadAuxiliaryLayer}
          onLoadGEDIPoints={handleLoadGEDIPoints}
          onSavePoint={(draft) => {
            const sentinelLayers = layerManager
              ?.getLayersByType('sentinel2')
              .filter((l: any) => l?.visible && l?.metadata?.url)
              .map((l: any) => ({
                id: l.id,
                name: l.name,
                url: String(l.metadata.url),
                tile_name: l.metadata.tileName,
                datetime: l.metadata.datetime,
                rgb_bands: Array.isArray(l.metadata.rgbBands) ? l.metadata.rgbBands : undefined,
                rescale_min: Number.isFinite(Number(l.metadata.rescaleMin)) ? Number(l.metadata.rescaleMin) : undefined,
                rescale_max: Number.isFinite(Number(l.metadata.rescaleMax)) ? Number(l.metadata.rescaleMax) : undefined,
              })) ?? [];

            // Forward the visible RH98 Q1 prediction layer's rescale/colormap so
            // the backend snapshot uses the same visualization as what the user
            // sees on the map (otherwise the snapshot defaults to 0..500/inferno).
            // Match the draft's year when present; fall back to any visible RH98
            // Q1 layer if no year match is found.
            const draftYear = Number((draft.metadata as any)?.year);
            const predictionCandidates = (layerManager?.getLayersByType('prediction') ?? [])
              .filter((l: any) =>
                l?.visible
                && l?.metadata
                && Number(l.metadata.rhIndex) === 98
                && Number(l.metadata.qIndex) === 1
                && l.metadata.layerType !== 'diversity_indices',
              );
            const predictionLayer =
              predictionCandidates.find((l: any) => Number.isFinite(draftYear) && Number(l.metadata.year) === draftYear)
              ?? predictionCandidates[0];
            const predictionVisualization = predictionLayer?.metadata
              ? {
                rescale_min: Number.isFinite(Number(predictionLayer.metadata.rescaleMin))
                  ? Number(predictionLayer.metadata.rescaleMin)
                  : undefined,
                rescale_max: Number.isFinite(Number(predictionLayer.metadata.rescaleMax))
                  ? Number(predictionLayer.metadata.rescaleMax)
                  : undefined,
                colormap: typeof predictionLayer.metadata.colormap === 'string' && predictionLayer.metadata.colormap.trim()
                  ? predictionLayer.metadata.colormap
                  : undefined,
              }
              : undefined;

            setSaveFeatureError(null);
            setFeatureDraft({
              ...draft,
              metadata: {
                ...(draft.metadata ?? {}),
                sentinel2_layers: sentinelLayers,
                ...(predictionVisualization ? { prediction_visualization: predictionVisualization } : {}),
              },
            });
          }}
          onClose={closePopup}
        />

        {inspectPanel && (
          <InspectPanel
            panel={inspectPanel}
            onClose={() => { setInspectPanel(null); clearInspectPin(); clearInspectLine(); }}
            onSave={(draft) => { setSaveFeatureError(null); setFeatureDraft(draft); }}
          />
        )}

        <SavedGediPointsList />

        <Snackbar
          open={saveSuccessOpen}
          autoHideDuration={3000}
          onClose={() => setSaveSuccessOpen(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert onClose={() => setSaveSuccessOpen(false)} severity="success" variant="filled" sx={{ width: '100%' }}>
            "{saveSuccessName}" saved — check Saved Locations in the sidebar.
          </Alert>
        </Snackbar>

        <SavedFeatureDialog
          open={featureDraft != null}
          geometryType={featureDraft?.geometry.type ?? null}
          saving={savingFeature}
          error={saveFeatureError}
          existingCategories={existingCategories}
          existingTags={existingTags}
          prefill={dialogPrefill}
          onCancel={handleCancelFeatureDraft}
          onSubmit={handleSaveFeatureDraft}
        />
      </div>
    </ThemeProvider>
  );
}

export default App;
