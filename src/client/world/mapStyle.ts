// Loads the base map style and restyles it into WORLDSTATE's stylised palette so the real-world
// basemap reads as terrain for the game rather than a navigation map. Falls back to a minimal
// offline style when tiles are unavailable.
import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';

const PALETTE = {
  land: '#cfc6a8',
  wood: '#8eab6b',
  grass: '#a9bf7e',
  farmland: '#d6cc9c',
  sand: '#e2d3a2',
  ice: '#eef2f3',
  water: '#3f7f9f',
  waterLine: '#3a7593',
  road: '#f1ebdc',
  roadCasing: '#b6ab90',
  osmBuilding: '#b4ab98',
  label: '#2f2a22',
  labelHalo: 'rgba(240,235,222,0.85)',
  boundary: '#8a7f6a',
};

const DROP = [/^poi/, /one_way/, /shield/, /^highway-name-path/, /^aeroway/, /building-3d/, /^tunnel_/, /hatching/];

function restyleLayer(l: LayerSpecification): LayerSpecification | null {
  if (DROP.some((r) => r.test(l.id))) return null;
  const id = l.id;
  const paint = { ...((l as { paint?: Record<string, unknown> }).paint ?? {}) };
  if (l.type === 'background') paint['background-color'] = PALETTE.land;
  if (l.type === 'fill') {
    if (id === 'water') paint['fill-color'] = PALETTE.water;
    else if (id.includes('wood')) paint['fill-color'] = PALETTE.wood;
    else if (id.includes('grass') || id === 'park' || id.includes('pitch') || id.includes('cemetery')) paint['fill-color'] = PALETTE.grass;
    else if (id.includes('sand')) paint['fill-color'] = PALETTE.sand;
    else if (id.includes('ice')) paint['fill-color'] = PALETTE.ice;
    else if (id.includes('residential')) { paint['fill-color'] = '#c4b99a'; paint['fill-opacity'] = 0.5; }
    else if (id === 'building') { paint['fill-color'] = PALETTE.osmBuilding; paint['fill-opacity'] = 0.55; delete paint['fill-outline-color']; }
  }
  if (l.type === 'line') {
    if (id.startsWith('waterway')) paint['line-color'] = PALETTE.waterLine;
    else if (id.includes('casing')) paint['line-color'] = PALETTE.roadCasing;
    else if (id.startsWith('road') || id.startsWith('bridge')) {
      if (!id.includes('rail')) paint['line-color'] = PALETTE.road;
    } else if (id.startsWith('boundary')) paint['line-color'] = PALETTE.boundary;
  }
  if (l.type === 'symbol') {
    paint['text-color'] = PALETTE.label;
    paint['text-halo-color'] = PALETTE.labelHalo;
    paint['text-halo-width'] = 1.2;
  }
  if (l.type === 'raster' && id === 'natural_earth') {
    paint['raster-saturation'] = -0.35;
    paint['raster-opacity'] = ['interpolate', ['linear'], ['zoom'], 0, 0.9, 6, 0.45, 8, 0];
  }
  return { ...l, paint } as LayerSpecification;
}

export function terrainUrl(): string | null {
  const v = process.env.NEXT_PUBLIC_TERRAIN_TILES ?? 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  return v === 'off' ? null : v;
}

function addTerrain(style: StyleSpecification) {
  const url = terrainUrl();
  if (!url) return;
  style.sources.dem = { type: 'raster-dem', tiles: [url], tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Terrain: Mapzen/Tilezen terrain tiles (AWS Open Data)' };
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  const hill: LayerSpecification = {
    id: 'ws-hillshade', type: 'hillshade', source: 'dem',
    paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#4a4234', 'hillshade-highlight-color': '#fffaf0', 'hillshade-accent-color': '#6d6250' },
  };
  style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, hill);
}

export function fallbackStyle(): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    glyphs: undefined,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#2c3a44' } }],
  } as StyleSpecification;
  return style;
}

export async function loadStyle(): Promise<{ style: StyleSpecification; fallback: boolean }> {
  const url = process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/liberty';
  if (url === 'local') return { style: fallbackStyle(), fallback: true };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`style HTTP ${res.status}`);
    const raw = (await res.json()) as StyleSpecification;
    const layers = raw.layers.map(restyleLayer).filter((l): l is LayerSpecification => !!l);
    const style: StyleSpecification = { ...raw, layers };
    addTerrain(style);
    return { style, fallback: false };
  } catch {
    return { style: fallbackStyle(), fallback: true };
  }
}
