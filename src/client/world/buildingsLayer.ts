// Three.js custom MapLibre layer that renders player buildings in stylised low-poly 3D.
// - Geometry per building part is built once and shared (cache).
// - Every (type, part) pair is drawn with one InstancedMesh, so N houses cost one draw call per part.
// - Level of detail: detailed models near the camera at high zoom, single coloured blocks otherwise.
// - Coordinates: scene metres relative to a floating origin (X east, Y up, Z south) to keep float32
//   precision; positions are projected through Web Mercator so they line up with the parcel grid.
import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import * as THREE from 'three';
import { CATEGORY_COLORS, getBuildingDef, type BuildingDef, type ModelPart } from '@/shared/config/buildings';
import type { BuildingSummary } from '../types';

const DETAIL_ZOOM = 15;
const MIN_ZOOM = 13;
const DETAIL_RADIUS_M = 2500;
const REORIGIN_M = 3000;

const geometryCache = new Map<string, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.Material>();

function roofGeometry(w: number, h: number, d: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Part geometry in model space (x east, y up, z north), converted to scene space (z south). */
function partGeometry(type: string, i: number, p: ModelPart): THREE.BufferGeometry {
  const key = `${type}:${i}`;
  let g = geometryCache.get(key);
  if (g) return g;
  switch (p.s) {
    case 'box': g = new THREE.BoxGeometry(p.w, p.h, p.d); g.translate(0, p.h / 2, 0); break;
    case 'cyl': g = new THREE.CylinderGeometry(p.w / 2, p.w / 2, p.h, 14); g.translate(0, p.h / 2, 0); break;
    case 'cone': g = new THREE.ConeGeometry(p.w / 2, p.h, 8); g.translate(0, p.h / 2, 0); break;
    case 'roof': g = roofGeometry(p.w, p.h, p.d); break;
  }
  g.translate(p.x ?? 0, p.y ?? 0, -(p.z ?? 0));
  g.computeVertexNormals();
  geometryCache.set(key, g);
  return g;
}

function material(color: string, opts: { ghost?: boolean } = {}): THREE.Material {
  const key = `${color}:${opts.ghost ? 'g' : ''}`;
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true, transparent: !!opts.ghost, opacity: opts.ghost ? 0.55 : 1, depthWrite: !opts.ghost });
    materialCache.set(key, m);
  }
  return m;
}

export interface LayerData {
  buildings: BuildingSummary[];
  myId: string | null;
  mySettlementId: string | null;
  selectedId: string | null;
}

export class BuildingsLayer implements CustomLayerInterface {
  id = 'ws-buildings';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  private map: MlMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private content = new THREE.Group();
  private ghost = new THREE.Group();
  private origin: maplibregl.MercatorCoordinate | null = null;
  private originLngLat: [number, number] | null = null;
  private scale = 1;
  private data: LayerData = { buildings: [], myId: null, mySettlementId: null, selectedId: null };
  private detailed = false;
  private ghostState: { type: string; valid: boolean } | null = null;
  private dirty = true;

  constructor() {
    this.scene.add(this.content);
    this.scene.add(this.ghost);
    const hemi = new THREE.HemisphereLight(0xf4f1ea, 0x5a5448, 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-0.6, 1, 0.35).normalize();
    this.scene.add(sun);
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    map.on('moveend', this.onMoveEnd);
  }

  onRemove() {
    this.map?.off('moveend', this.onMoveEnd);
    this.renderer?.dispose();
    this.renderer = null;
  }

  private onMoveEnd = () => {
    if (!this.map) return;
    const detailed = this.map.getZoom() >= DETAIL_ZOOM;
    const c = this.map.getCenter();
    const far = !this.originLngLat || distM(this.originLngLat, [c.lng, c.lat]) > REORIGIN_M;
    if (detailed !== this.detailed || far || detailed) this.dirty = true;
    if (this.dirty) this.map.triggerRepaint();
  };

  setData(d: LayerData) {
    this.data = d;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  /** Placement preview. Pass null to clear. */
  setGhost(g: { type: string; lngLat: [number, number]; rotation: number; valid: boolean } | null) {
    if (!g) {
      this.ghost.clear();
      this.ghostState = null;
      this.map?.triggerRepaint();
      return;
    }
    const def = getBuildingDef(g.type);
    if (!def) return;
    if (!this.ghostState || this.ghostState.type !== g.type || this.ghostState.valid !== g.valid) {
      this.ghost.clear();
      const tint = g.valid ? '#7fe0b0' : '#ff7a6b';
      def.model.forEach((p, i) => this.ghost.add(new THREE.Mesh(partGeometry(def.type, i, p), material(tint, { ghost: true }))));
      const base = new THREE.Mesh(new THREE.PlaneGeometry(def.width + 2, def.depth + 2).rotateX(-Math.PI / 2), material(tint, { ghost: true }));
      base.position.y = 0.15;
      this.ghost.add(base);
      this.ghostState = { type: g.type, valid: g.valid };
    }
    this.ensureOrigin(g.lngLat);
    const pos = this.toScene(g.lngLat);
    this.ghost.position.set(pos.x, 0, pos.z);
    this.ghost.rotation.set(0, (-g.rotation * Math.PI) / 180, 0);
    this.map?.triggerRepaint();
  }

  private ensureOrigin(ll: [number, number]) {
    if (this.originLngLat && distM(this.originLngLat, ll) < REORIGIN_M * 2) return;
    this.setOrigin(ll);
  }

  private setOrigin(ll: [number, number]) {
    this.originLngLat = ll;
    this.origin = maplibregl.MercatorCoordinate.fromLngLat(ll, 0);
    this.scale = this.origin.meterInMercatorCoordinateUnits();
    this.dirty = true;
  }

  private toScene(ll: [number, number]) {
    const m = maplibregl.MercatorCoordinate.fromLngLat(ll, 0);
    return { x: (m.x - this.origin!.x) / this.scale, z: (m.y - this.origin!.y) / this.scale };
  }

  private rebuild() {
    this.dirty = false;
    if (!this.map) return;
    const c = this.map.getCenter();
    const center: [number, number] = [c.lng, c.lat];
    if (!this.originLngLat || distM(this.originLngLat, center) > REORIGIN_M) this.setOrigin(center);
    this.dirty = false;
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    const zoom = this.map.getZoom();
    this.detailed = zoom >= DETAIL_ZOOM;
    const { buildings, myId, mySettlementId, selectedId } = this.data;

    const detail = new Map<string, BuildingSummary[]>();
    const simple: BuildingSummary[] = [];
    for (const b of buildings) {
      if (this.detailed && distM(center, [b.lng, b.lat]) < DETAIL_RADIUS_M) {
        const list = detail.get(b.type) ?? [];
        list.push(b);
        detail.set(b.type, list);
      } else simple.push(b);
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const placeMatrix = (b: BuildingSummary, def: BuildingDef, sx = 1, sy = 1, sz = 1) => {
      const p = this.toScene([b.lng, b.lat]);
      q.setFromAxisAngle(up, (-b.rotation * Math.PI) / 180);
      const levelScale = 1 + 0.12 * (b.level - 1);
      return m4.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(sx, sy * (def.category === 'infrastructure' && def.type === 'road' ? 1 : levelScale), sz));
    };

    // Detailed: one InstancedMesh per (type, part).
    for (const [type, list] of detail) {
      const def = getBuildingDef(type);
      if (!def) continue;
      def.model.forEach((part, i) => {
        const mesh = new THREE.InstancedMesh(partGeometry(type, i, part), material(part.c), list.length);
        list.forEach((b, k) => mesh.setMatrixAt(k, placeMatrix(b, def)));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.content.add(mesh);
      });
    }

    // Simplified LOD: a single coloured block per building.
    if (simple.length) {
      const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const mesh = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ flatShading: true }), simple.length);
      const color = new THREE.Color();
      simple.forEach((b, k) => {
        const def = getBuildingDef(b.type);
        if (!def) return;
        mesh.setMatrixAt(k, placeMatrix(b, def, def.width * 0.9, Math.max(1, def.height * 0.85), def.depth * 0.9));
        mesh.setColorAt(k, color.set(CATEGORY_COLORS[def.category]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.content.add(mesh);
    }

    // Ownership plates: a thin footprint under every building, tinted by owner.
    if (buildings.length) {
      const plate = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0.08, 0);
      const mesh = new THREE.InstancedMesh(plate, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }), buildings.length);
      const color = new THREE.Color();
      buildings.forEach((b, k) => {
        const def = getBuildingDef(b.type);
        if (!def) return;
        mesh.setMatrixAt(k, placeMatrix(b, def, def.width + 3, 1, def.depth + 3));
        const tint = b.id === selectedId ? '#ffffff' : b.ownerId && b.ownerId === myId ? '#3fc1a5' : b.settlementId && b.settlementId === mySettlementId ? '#a98bf0' : b.settlementId ? '#7c6aa8' : '#6b7280';
        mesh.setColorAt(k, color.set(tint));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.content.add(mesh);
    }

    // Activity markers above producing businesses.
    const active = buildings.filter((b) => b.status === 'producing');
    if (active.length && this.detailed) {
      const cone = new THREE.OctahedronGeometry(1.6);
      const mesh = new THREE.InstancedMesh(cone, new THREE.MeshBasicMaterial({ color: '#f2c14e' }), active.length);
      active.forEach((b, k) => {
        const def = getBuildingDef(b.type)!;
        const p = this.toScene([b.lng, b.lat]);
        mesh.setMatrixAt(k, m4.makeTranslation(p.x, def.height * (1 + 0.12 * (b.level - 1)) + 5, p.z));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.content.add(mesh);
    }

    // Selection outline.
    const sel = selectedId ? buildings.find((b) => b.id === selectedId) : null;
    const selDef = sel ? getBuildingDef(sel.type) : null;
    if (sel && selDef) {
      const box = new THREE.BoxGeometry(selDef.width + 1.5, selDef.height * (1 + 0.12 * (sel.level - 1)) + 1.5, selDef.depth + 1.5).translate(0, (selDef.height + 1.5) / 2, 0);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#ffffff' }));
      const p = this.toScene([sel.lng, sel.lat]);
      edges.position.set(p.x, 0, p.z);
      edges.rotation.y = (-sel.rotation * Math.PI) / 180;
      this.content.add(edges);
    }
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.map || !this.renderer) return;
    // Buildings are only drawn once the globe has flattened into Web Mercator at local zooms.
    if (this.map.getZoom() < MIN_ZOOM || args.shaderData.variantName !== 'mercator') return;
    if (this.dirty || !this.origin) this.rebuild();
    if (!this.origin) return;
    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    const l = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.camera.projectionMatrix = m.multiply(l);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}

function distM(a: [number, number], b: [number, number]) {
  const dy = (b[1] - a[1]) * 111_320;
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dx, dy);
}
