'use client';

import maplibregl, { type GeoJSONSource, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { ensureChunks, game, toast } from '../game';
import { placeBuilding } from '../actions';
import { realtime } from '../realtime';
import type { Chunk, Me } from '../types';
import { BuildingsLayer } from './buildingsLayer';
import { loadStyle } from './mapStyle';
import { buildingAt, checkPlacement } from './placement';
import { getBuildingDef } from '@/shared/config/buildings';
import { footprintRing } from '@/shared/geo';
import { MAX_CHUNKS_PER_REQUEST, PARCEL_MIN_ZOOM, chunkBounds, chunkKeyAt, chunksInBounds, parcelIdAt, parcelRing } from '@/shared/grid';

const BUILDING_MIN_ZOOM = 13;

const STATE_COLORS: Record<string, string> = {
  available: '#e8e0c8',
  mine: '#3fc1a5',
  owned: '#d08a5c',
  settlement: '#7c6aa8',
  mysettlement: '#a98bf0',
  restricted: '#b84a4a',
  water: '#3f7f9f',
};

function visibleChunkKeys(map: MlMap): string[] {
  if (map.getZoom() < BUILDING_MIN_ZOOM) return [];
  const b = map.getBounds();
  const keys = chunksInBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
  if (keys.length <= MAX_CHUNKS_PER_REQUEST) return keys;
  // Keep the chunks nearest the centre (bounded request size at oblique pitches).
  const c = map.getCenter();
  return keys
    .map((k) => {
      const cb = chunkBounds(k);
      return { k, d: Math.hypot((cb.west + cb.east) / 2 - c.lng, (cb.south + cb.north) / 2 - c.lat) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_CHUNKS_PER_REQUEST)
    .map((x) => x.k);
}

function parcelFeatures(chunks: Map<string, Chunk>, keys: string[], me: Me | null, fallback: boolean) {
  const features: import('geojson').Feature[] = [];
  for (const k of keys) {
    const c = chunks.get(k);
    if (!c) continue;
    const owners = new Map(c.parcels.map((p) => [p.id, p]));
    for (const [id, cls] of Object.entries(c.cells)) {
      if (cls === 'water' && !fallback) continue;
      const o = owners.get(id);
      let state: string = cls === 'water' || cls === 'restricted' ? cls : 'available';
      if (o?.settlementId) state = o.settlementId === me?.settlement?.id ? 'mysettlement' : 'settlement';
      else if (o?.ownerId) state = o.ownerId === me?.id ? 'mine' : 'owned';
      features.push({ type: 'Feature', id: undefined, properties: { id, state, cls }, geometry: { type: 'Polygon', coordinates: [parcelRing(id)] } });
    }
  }
  return { type: 'FeatureCollection' as const, features };
}

export default function WorldMap() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const layerRef = useRef<BuildingsLayer | null>(null);
  const keysRef = useRef<string[]>([]);
  const fallbackRef = useRef(false);
  const readyRef = useRef(false);
  const flySeqRef = useRef(0);

  // Camera requests can arrive before the map has loaded; apply the latest one when possible.
  const applyFlyTo = () => {
    const map = mapRef.current;
    const f = game.get().flyTo;
    if (!map || !readyRef.current || !f || f.seq === flySeqRef.current) return;
    flySeqRef.current = f.seq;
    map.flyTo({ center: [f.lng, f.lat], zoom: f.zoom ?? Math.max(map.getZoom(), 16), pitch: 55, speed: 1.6 });
  };

  useEffect(() => {
    let disposed = false;
    let map: MlMap | null = null;
    (async () => {
      const { style, fallback } = await loadStyle();
      if (disposed || !container.current) return;
      fallbackRef.current = fallback;
      const v = game.get().view;
      map = new maplibregl.Map({
        container: container.current,
        style,
        center: [v.lng, v.lat],
        zoom: v.zoom,
        pitch: v.pitch,
        bearing: v.bearing,
        maxPitch: 70,
        attributionControl: { compact: true, customAttribution: 'Geography: Natural Earth · Game world: WORLDSTATE' },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
      map.on('error', (e) => {
        // Tile/network errors should not break the game; parcels and buildings come from our API.
        if ((e.error as Error | undefined)?.message?.includes('Failed to fetch')) game.set({ mapStatus: 'fallback' });
      });
      map.on('load', () => {
        if (!map) return;
        try {
          map.setProjection({ type: 'globe' });
        } catch { /* older renderers: mercator only */ }
        map.setSky({ 'sky-color': '#0d1420', 'horizon-color': '#22324a', 'fog-color': '#1a2433', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.4, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0] });
        map.addSource('ws-parcels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addSource('ws-selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addSource('ws-footprint', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        const colorExpr = ['match', ['get', 'state'], ...Object.entries(STATE_COLORS).flat(), '#e8e0c8'] as unknown as maplibregl.ExpressionSpecification;
        map.addLayer({
          id: 'ws-parcel-fill', type: 'fill', source: 'ws-parcels', minzoom: PARCEL_MIN_ZOOM,
          paint: {
            'fill-color': colorExpr,
            'fill-opacity': ['match', ['get', 'state'], 'available', 0.08, 'water', fallback ? 0.9 : 0, 'restricted', 0.25, 0.32],
          },
        });
        map.addLayer({
          id: 'ws-parcel-line', type: 'line', source: 'ws-parcels', minzoom: PARCEL_MIN_ZOOM,
          paint: {
            'line-color': colorExpr,
            'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.4, 17, 1.4],
            'line-opacity': ['match', ['get', 'state'], 'available', 0.45, 'water', 0, 0.9],
          },
        });
        map.addLayer({ id: 'ws-selected-line', type: 'line', source: 'ws-selected', paint: { 'line-color': '#ffffff', 'line-width': 2.5 } });
        map.addLayer({
          id: 'ws-footprint-line', type: 'line', source: 'ws-footprint',
          paint: { 'line-color': ['case', ['get', 'valid'], '#7fe0b0', '#ff7a6b'], 'line-width': 2, 'line-dasharray': [2, 1] },
        });
        const layer = new BuildingsLayer();
        layerRef.current = layer;
        map.addLayer(layer);
        readyRef.current = true;
        game.set({ mapStatus: fallback ? 'fallback' : 'ready' });
        onMove();
        syncLayers();
        applyFlyTo();
      });

      const onMove = () => {
        if (!map) return;
        const c = map.getCenter();
        game.set({ view: { lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() } });
        const keys = visibleChunkKeys(map);
        keysRef.current = keys;
        realtime.setChunks(keys);
        realtime.setFocus(map.getZoom() >= BUILDING_MIN_ZOOM ? chunkKeyAt(c.lng, c.lat) : null);
        if (keys.length) ensureChunks(keys);
        syncLayers();
      };
      map.on('moveend', onMove);

      map.on('click', (e) => {
        const ll: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        const s = game.get();
        if (s.placement) {
          confirmPlacement(ll);
          return;
        }
        if (!map || map.getZoom() < BUILDING_MIN_ZOOM) {
          map?.flyTo({ center: e.lngLat, zoom: Math.min(16, (map?.getZoom() ?? 2) + 3) });
          return;
        }
        const b = buildingAt(ll, s.chunks);
        if (b) {
          game.set({ selection: { kind: 'building', id: b.id }, panel: 'world' });
          return;
        }
        if (map.getZoom() >= PARCEL_MIN_ZOOM) game.set({ selection: { kind: 'parcel', id: parcelIdAt(ll[0], ll[1]) }, panel: 'world' });
      });

      map.on('mousemove', (e) => {
        const s = game.get();
        if (!s.placement) return;
        updatePlacement([e.lngLat.lng, e.lngLat.lat]);
      });
    })();

    return () => {
      disposed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Keep map layers in sync with the store.
  const syncLayers = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getSource('ws-parcels')) return;
    const s = game.get();
    const keys = keysRef.current;
    (map.getSource('ws-parcels') as GeoJSONSource).setData(parcelFeatures(s.chunks, keys, s.me, fallbackRef.current));
    const buildings = keys.flatMap((k) => s.chunks.get(k)?.buildings ?? []);
    layerRef.current?.setData({ buildings, myId: s.me?.id ?? null, mySettlementId: s.me?.settlement?.id ?? null, selectedId: s.selection?.kind === 'building' ? s.selection.id : null });
    const sel = s.selection?.kind === 'parcel' ? s.selection.id : null;
    (map.getSource('ws-selected') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: sel ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: parcelRing(sel) } }] : [],
    });
  };

  const updatePlacement = (ll: [number, number]) => {
    const s = game.get();
    if (!s.placement) return;
    const check = checkPlacement(s.placement.type, ll, s.placement.rotation, s.me, s.chunks);
    game.set({ placement: { ...s.placement, lngLat: ll, parcelId: check.parcelId, valid: check.valid, reason: check.reason } });
  };

  const confirmPlacement = async (ll?: [number, number]) => {
    const s = game.get();
    const p = s.placement;
    if (!p) return;
    const at = ll ?? p.lngLat;
    if (!at) return;
    const check = checkPlacement(p.type, at, p.rotation, s.me, s.chunks);
    if (p.projectFor) {
      // Choosing a settlement project site: hand the location back to the settlements panel.
      game.set({ placement: { ...p, lngLat: at, parcelId: check.parcelId, valid: true, reason: null } });
      window.dispatchEvent(new CustomEvent('ws:project-site', { detail: { parcelId: check.parcelId, lng: at[0], lat: at[1], rotation: p.rotation } }));
      return;
    }
    if (!check.valid && check.blocking) {
      toast('error', check.reason ?? 'Invalid placement');
      return;
    }
    const r = await placeBuilding(p.type, check.parcelId, at, p.rotation);
    if (r) game.set({ placement: null, selection: { kind: 'building', id: r.building.id } });
  };

  // Subscribe to store changes affecting the map.
  useEffect(() => {
    let prev = game.get();
    return game.subscribe(() => {
      const s = game.get();
      const map = mapRef.current;
      if (s.chunkVersion !== prev.chunkVersion || s.selection !== prev.selection || s.me !== prev.me) syncLayers();
      if (s.placement !== prev.placement) {
        const p = s.placement;
        const src = map?.getSource('ws-footprint') as GeoJSONSource | undefined;
        if (p?.lngLat) {
          const def = getBuildingDef(p.type)!;
          layerRef.current?.setGhost({ type: p.type, lngLat: p.lngLat, rotation: p.rotation, valid: p.valid });
          src?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { valid: p.valid }, geometry: { type: 'LineString', coordinates: footprintRing(p.lngLat, def.width, def.depth, p.rotation) } }] });
        } else {
          layerRef.current?.setGhost(null);
          src?.setData({ type: 'FeatureCollection', features: [] });
        }
        if (map) map.getCanvas().style.cursor = p ? 'crosshair' : '';
        if (p && !prev.placement && map && !p.lngLat) {
          // Start the preview at the map centre so keyboard users can place without a mouse.
          const c = map.getCenter();
          updatePlacement([c.lng, c.lat]);
        }
        if (p && prev.placement && p.rotation !== prev.placement.rotation && p.lngLat) updatePlacement(p.lngLat);
      }
      if (s.flyTo !== prev.flyTo) applyFlyTo();
      prev = s;
    });
  }, []);

  // Keyboard placement controls: arrows nudge, R rotates, Enter confirms, Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = game.get();
      if (!s.placement) return;
      const target = e.target as HTMLElement;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const p = s.placement;
      if (e.key === 'Escape') { game.set({ placement: null }); return; }
      if (e.key === 'r' || e.key === 'R') { game.set({ placement: { ...p, rotation: (p.rotation + (e.shiftKey ? 345 : 15)) % 360 } }); return; }
      if (e.key === 'Enter') { e.preventDefault(); confirmPlacement(); return; }
      const step = e.shiftKey ? 10 : 2;
      const d: Record<string, [number, number]> = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
      if (d[e.key] && p.lngLat) {
        e.preventDefault();
        const [de, dn] = d[e.key];
        const lat = p.lngLat[1] + dn / 111_320;
        const lng = p.lngLat[0] + de / (111_320 * Math.cos((lat * Math.PI) / 180));
        updatePlacement([lng, lat]);
      }
    };
    const onConfirm = () => confirmPlacement();
    window.addEventListener('keydown', onKey);
    window.addEventListener('ws:confirm-placement', onConfirm);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('ws:confirm-placement', onConfirm);
    };
  }, []);

  return (
    <div className="absolute inset-0" data-testid="world-map">
      <div ref={container} className="h-full w-full" aria-label="World map. Click to select; use the side panel for keyboard navigation." role="application" />
    </div>
  );
}
