import type { LatLon } from '../components/map/types';

/**
 * Initial camera that fits a set of places in the visible part of the window
 * (Web Mercator, 512 px tiles as used by MapLibre). Pure logic, unit-tested.
 */
export interface Camera {
  center: LatLon;
  zoom: number;
}

export interface FitOptions {
  /** Visible map area in points (window minus overlays). */
  width: number;
  height: number;
  /** Zoom never goes above this (a single place should not zoom to street level). */
  maxZoom: number;
  /** Used when there is no place. */
  fallback: Camera;
}

const TILE = 512;

function mercY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function unmercY(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function fitCamera(points: readonly LatLon[], opts: FitOptions): Camera {
  if (points.length === 0 || opts.width <= 0 || opts.height <= 0) return opts.fallback;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = (p.lon + 180) / 360;
    const y = mercY(p.lat);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const zx = dx > 0 ? Math.log2(opts.width / (TILE * dx)) : Infinity;
  const zy = dy > 0 ? Math.log2(opts.height / (TILE * dy)) : Infinity;
  const zoom = Math.min(opts.maxZoom, zx, zy);
  return {
    center: { lon: ((minX + maxX) / 2) * 360 - 180, lat: unmercY((minY + maxY) / 2) },
    zoom: Math.round(zoom * 100) / 100,
  };
}
