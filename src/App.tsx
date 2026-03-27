import React, { useCallback, useEffect } from 'react';
import './App.css';
import { MapComponent, type Map } from './components/Map';
import { SidebarContainer } from './containers/SidebarContainer';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { LayerControl } from './components/LayerControl';
import { FeaturePopup } from './components/FeaturePopup';
import { TileSearch } from './components/TileSearch';
import { BaseMapSelector } from './components/BaseMapSelector';
import { MapColorbarOverlay } from './components/MapColorbarOverlay';
import { GediPointPopup } from './components/GediPointPopup';
import { LayerManager } from './utils/LayerManager';
import { useMapStore } from './stores/mapStore';
import { InspectPanel } from './components/InspectPanel';

import { useLayerLoaders } from './hooks/useLayerLoaders';
import { useAutoLoadVSM } from './hooks/useAutoLoadVSM';
import { useMapInteractions } from './hooks/useMapInteractions';
import { useLayerControls } from './hooks/useLayerControls';

const theme = createTheme({ palette: { mode: 'light', primary: { main: '#1976d2' } } });

function App() {
  const {
    map, setMap, cogLayer, fgbLayer,
    layers, setLayers, popupProperties, popupPosition, popupGeometry, popupCoordinates,
    layerManager, setLayerManager, closePopup, inspectMode, inspectPanel, setInspectPanel,
  } = useMapStore();

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
      layerManager.addLayer('fgb', 'FlatGeobuf Layer', 'fgb', fgbLayer, metadata);
      updateLayersList();
    } else if (!fgbLayer) { layerManager.removeLayer('fgb'); updateLayersList(); }
  }, [fgbLayer, map, layerManager, updateLayersList]);

  React.useEffect(() => { updateLayersList(); }, [updateLayersList]);

  // Hooks
  const { handleLoadSentinel2Image, handleLoadPredictionCOG, handleLoadAuxiliaryLayer, handleLoadGEDIPoints } = useLayerLoaders(updateLayersList);
  const { showZoomMessage, globalLayersRef } = useAutoLoadVSM(updateLayersList);
  const { gediPointPopup, setGediPointPopup, clearInspectPin } = useMapInteractions(updateLayersList);
  const {
    handleToggleVisibility, handleChangeOpacity, handleChangeZIndex,
    handleChangePredictionRescale, handleReorderLayers, handleRemoveLayer,
    handleLocateLayer, vectorFeatures, handleHighlightFeature, handleRemoveFeature,
  } = useLayerControls(updateLayersList, globalLayersRef);

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

        {gediPointPopup && (
          <GediPointPopup data={gediPointPopup} onClose={() => setGediPointPopup(null)} />
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
          onClose={closePopup}
        />

        {inspectMode && inspectPanel && (
          <InspectPanel
            panel={inspectPanel}
            onClose={() => { setInspectPanel(null); clearInspectPin(); }}
          />
        )}
      </div>
    </ThemeProvider>
  );
}

export default App;
