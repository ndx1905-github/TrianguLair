/**
 * New zone (T-110): three ways to make the shape (spec "Zones"):
 *
 * - Neighbourhood: tap one of the OSM neighbourhoods drawn on the map, or
 *   search one by name;
 * - Street: tap a street for the start, tap again for the end; the path
 *   follows the streets; "Add a segment" chains another (contiguous when it
 *   starts at the previous end, separate otherwise);
 * - Draw: by points (tap the vertices, tap the first to close, then tap a
 *   vertex and tap where it goes, or tap an edge to add one) or by painting
 *   (finger like a marker, three thicknesses, eraser).
 *
 * Then the zone gets the same fields as a place and is saved as GeoJSON
 * through the data package. With `purpose = 'list'`, the shape (an area) is
 * handed back to the list editor instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { newLocalPlaceId, placeIdFromOsm, type FilterZone, type PlaceGeometry } from '@triangulair/data';
import type { LineString, MultiLineString, MultiPolygon, Polygon } from 'geojson';

import Map from '../components/map/Map';
import type { LatLon, MapRegion } from '../components/map/types';
import { MapAttribution } from '../components/MapAttribution';
import type { SaveFields } from '../components/SaveEditor';
import { Banner, Button, Pill, Segmented } from '../components/ui';
import { INITIAL_CENTER, INITIAL_ZOOM, MAP_STYLE_URL, MAP_STYLE_URL_DARK, OSM_FIXTURES } from '../config';
import { useData } from '../data/DataProvider';
import { useLayout } from '../hooks/useLayout';
import { useIsDark, useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { osmClient } from '../osm/client';
import { classifyOsmError } from '../osm/errors';
import { formatDistance } from '../places/card';
import { useAppState } from '../state/AppState';
import { EMPTY_POINTS, pointsProblem, pointsToPolygon, tapPoints, undoPoint, type PointsDraft } from './drawing';
import { localFrame, metresPerPixel, screenToLatLon, type Viewport } from './geo';
import { bboxSizeM, fetchNeighbourhoods, fetchStreets, searchAreas, type BBoxTuple, type OsmArea } from './osmZones';
import { PaintOverlay, type ScreenPoint } from './PaintOverlay';
import { setPendingListZone } from './pendingZone';
import { bufferLines, strokesToArea, type Stroke } from './raster';
import type { MapShape } from './shapes';
import { linesLengthM, segmentsToGeometry, StreetNetwork, type Snap } from './streets';
import { ZoneForm } from './ZoneForm';

type Mode = 'area' | 'street' | 'draw';
type DrawKind = 'points' | 'paint';
type Brush = 'S' | 'M' | 'L';
const BRUSH_PX: Record<Brush, number> = { S: 14, M: 28, L: 52 };
/** Touch tolerance, px (converted to metres at the current zoom). */
const HIT_PX = 22;
const STREET_HIT_PX = 36;
/** Neighbourhoods are fetched from this zoom, streets from this one. */
const AREA_MIN_ZOOM = 13;
const STREET_MIN_ZOOM = 15;
const STREET_BUFFER_M = 25;

interface Segment {
  line: LatLon[];
  names: string[];
}

interface Result {
  geometry: PlaceGeometry;
  edge: 'sharp' | 'blurred';
  osm: OsmArea | null;
  name: string;
  summary: string;
}

function metres(a: LatLon, b: LatLon): number {
  return Math.hypot(...localFrame(a).toXY(b));
}

function padded(b: MapRegion['bbox'], f: number): BBoxTuple {
  const [w, s, e, n] = b;
  const dx = (e - w) * f;
  const dy = (n - s) * f;
  return [w - dx, s - dy, e + dx, n + dy];
}

function contains(outer: BBoxTuple | null, inner: MapRegion['bbox']): boolean {
  return !!outer && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function areaCenter(g: Polygon | MultiPolygon): LatLon {
  const ring = g.type === 'Polygon' ? g.coordinates[0]! : g.coordinates[0]![0]!;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of ring) {
    lon += x!;
    lat += y!;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

export function ZoneEditor({ purpose = 'save' }: { purpose?: 'save' | 'list' }) {
  const c = useUiColors();
  const dark = useIsDark();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { wide, gutter, sheetWidth, height } = useLayout();
  const { repo, mutate } = useData();
  const { region: lastRegion, focusPlace } = useAppState();

  const [initial] = useState(() =>
    lastRegion ? { center: lastRegion.center, zoom: Math.max(lastRegion.zoom, purpose === 'list' ? 5 : 14) } : { center: INITIAL_CENTER, zoom: INITIAL_ZOOM },
  );
  const [region, setRegion] = useState<MapRegion | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const viewport: Viewport | null = region && size.width > 0 ? { bbox: region.bbox, ...size } : null;
  const mpp = viewport ? metresPerPixel(viewport) : 1;
  const [camera, setCamera] = useState<{ center: LatLon; zoom: number; key: number } | null>(null);

  const [mode, setMode] = useState<Mode>(purpose === 'list' ? 'area' : 'area');
  const [step, setStep] = useState<'shape' | 'form'>('shape');

  // ---------------------------------------------------------------- neighbourhoods
  const [areas, setAreas] = useState<OsmArea[]>([]);
  const [areasBox, setAreasBox] = useState<BBoxTuple | null>(null);
  const [areaStatus, setAreaStatus] = useState<'idle' | 'loading' | 'error' | 'zoom'>('idle');
  const [picked, setPicked] = useState<OsmArea | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OsmArea[] | null>(null);
  const [searching, setSearching] = useState(false);

  // ---------------------------------------------------------------- streets
  const [network, setNetwork] = useState<StreetNetwork | null>(null);
  const [streetsBox, setStreetsBox] = useState<BBoxTuple | null>(null);
  const [streetStatus, setStreetStatus] = useState<'idle' | 'loading' | 'error' | 'zoom'>('idle');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [start, setStart] = useState<Snap | null>(null);
  const [end, setEnd] = useState<Snap | null>(null);
  const [streetMsg, setStreetMsg] = useState<string | null>(null);

  // ---------------------------------------------------------------- drawing
  const [drawKind, setDrawKind] = useState<DrawKind>('points');
  const [points, setPoints] = useState<PointsDraft>(EMPTY_POINTS);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [brush, setBrush] = useState<Brush>('M');
  const [eraser, setEraser] = useState(false);
  const [moveMap, setMoveMap] = useState(false);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // Fetch neighbourhoods / streets for the visible area (padded), when zoomed in enough.
  const fetchCtrl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!region || step !== 'shape') return;
    const wantAreas = mode === 'area';
    const wantStreets = mode === 'street';
    if (!wantAreas && !wantStreets) return;
    const minZoom = wantAreas ? AREA_MIN_ZOOM : STREET_MIN_ZOOM;
    const setStatus = wantAreas ? setAreaStatus : setStreetStatus;
    if (region.zoom < minZoom - 0.01) {
      setStatus('zoom');
      return;
    }
    const have = wantAreas ? areasBox : streetsBox;
    if (contains(have, region.bbox)) {
      setStatus('idle');
      return;
    }
    const box = padded(region.bbox, 0.5);
    if (bboxSizeM(box) > (wantAreas ? 15_000 : 3_000)) {
      setStatus('zoom');
      return;
    }
    const timer = setTimeout(() => {
      fetchCtrl.current?.abort();
      const ctrl = new AbortController();
      fetchCtrl.current = ctrl;
      setStatus('loading');
      const osm = osmClient();
      const job = wantAreas
        ? fetchNeighbourhoods(osm, box, ctrl.signal).then((list) => {
            setAreas(list);
            setAreasBox(box);
          })
        : fetchStreets(osm, box, ctrl.signal).then((ways) => {
            setNetwork(new StreetNetwork(ways));
            setStreetsBox(box);
          });
      job.then(
        () => !ctrl.signal.aborted && setStatus('idle'),
        (e: unknown) => {
          if (classifyOsmError(e) !== 'aborted') setStatus('error');
        },
      );
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, mode, step]);
  useEffect(() => () => fetchCtrl.current?.abort(), []);

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const list = await searchAreas(osmClient(), query, tr.locale);
      setResults(list);
    } catch (e) {
      if (classifyOsmError(e) !== 'aborted') setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const pickArea = (a: OsmArea, move: boolean) => {
    setPicked(a);
    if (move) setCamera({ center: areaCenter(a.geometry), zoom: Math.max(region?.zoom ?? 0, purpose === 'list' ? 11 : 14.5), key: Date.now() });
  };

  // ---------------------------------------------------------------- taps on the map
  const onMapPress = useCallback(
    (at: LatLon) => {
      if (step !== 'shape') return;
      if (mode === 'draw' && drawKind === 'points') {
        setPoints((d) => tapPoints(d, at, HIT_PX * mpp));
        return;
      }
      if (mode === 'street') {
        if (!network) return;
        const hit = network.snap(at, STREET_HIT_PX * mpp);
        if (!hit) {
          setStreetMsg(t('zone.street.tapCloser'));
          return;
        }
        setStreetMsg(null);
        if (!start) {
          // Chain: a start near the previous end continues the same line (contiguous).
          const prev = segments[segments.length - 1];
          const prevEnd = prev?.line[prev.line.length - 1];
          if (prevEnd && metres(prevEnd, hit.point) < HIT_PX * mpp) {
            const near = network.snap(prevEnd, 1);
            if (near) {
              setStart({ ...near, point: prevEnd });
              return;
            }
          }
          setStart(hit);
          return;
        }
        if (!end) {
          if (network.path(start, hit).length < 2) {
            setStreetMsg(t('zone.street.noPath'));
            return;
          }
          setEnd(hit);
          return;
        }
        // Both handles set: the tap moves the nearest one.
        if (metres(start.point, at) <= metres(end.point, at)) setStart(hit);
        else setEnd(hit);
      }
    },
    [step, mode, drawKind, mpp, network, start, end, segments, t],
  );

  const currentPath = useMemo(() => (network && start && end ? network.path(start, end) : []), [network, start, end]);
  const currentNames = useMemo(() => {
    if (!network || !start) return [];
    const names = [start, end].filter((s): s is Snap => !!s).map((s) => network.ways.get(s.wayId)?.name ?? '');
    return [...new Set(names.filter(Boolean))];
  }, [network, start, end]);

  const addSegment = () => {
    if (currentPath.length < 2) return;
    setSegments((s) => [...s, { line: currentPath, names: currentNames }]);
    setStart(null);
    setEnd(null);
  };
  const undoSegment = () => {
    if (start || end) {
      setStart(null);
      setEnd(null);
    } else setSegments((s) => s.slice(0, -1));
  };
  const allSegments = useMemo(
    () => (currentPath.length >= 2 ? [...segments, { line: currentPath, names: currentNames }] : segments),
    [segments, currentPath, currentNames],
  );

  // ---------------------------------------------------------------- painting
  const onStroke = (pts: ScreenPoint[]) => {
    if (!viewport) return;
    const radiusM = (BRUSH_PX[brush] / 2) * mpp;
    setStrokes((s) => [...s, { points: pts.map((p) => screenToLatLon(viewport, p.x, p.y)), radiusM, ...(eraser ? { erase: true } : {}) }]);
  };
  const painted = useMemo(() => strokesToArea(strokes), [strokes]);

  // ---------------------------------------------------------------- the result
  const result: Result | null = useMemo(() => {
    if (mode === 'area' && picked) {
      return {
        geometry: picked.geometry,
        edge: 'sharp',
        osm: picked,
        name: picked.name,
        summary: t('zone.summary.area', { name: picked.name }),
      };
    }
    if (mode === 'street') {
      const g = segmentsToGeometry(allSegments.map((s) => s.line));
      if (!g) return null;
      const names = [...new Set(allSegments.flatMap((s) => s.names))];
      const lines = g.type === 'LineString' ? 1 : g.coordinates.length;
      return {
        geometry: g,
        edge: 'sharp',
        osm: null,
        name: names.join(' – ') || t('zone.defaultName'),
        summary: t('zone.summary.street', {
          count: lines,
          length: formatDistance(linesLengthM(allSegments.map((s) => s.line)), tr) ?? '',
        }),
      };
    }
    if (mode === 'draw' && drawKind === 'points') {
      const g = pointsToPolygon(points);
      return g ? { geometry: g, edge: 'sharp', osm: null, name: t('zone.defaultName'), summary: t('zone.summary.points', { count: g.coordinates[0]!.length - 1 }) } : null;
    }
    if (mode === 'draw' && drawKind === 'paint' && painted) {
      return { geometry: painted, edge: 'blurred', osm: null, name: t('zone.defaultName'), summary: t('zone.summary.paint') };
    }
    return null;
  }, [mode, picked, allSegments, drawKind, points, painted, t, tr]);

  // ---------------------------------------------------------------- shapes on the map
  const shapes = useMemo<MapShape[]>(() => {
    const accent = c.accent;
    const out: MapShape[] = [];
    if (step === 'shape' && mode === 'area') {
      for (const a of areas) {
        if (picked && a.osmId === picked.osmId && a.osmType === picked.osmType) continue;
        out.push({ id: `area:${a.osmType}/${a.osmId}`, geometry: a.geometry, color: '#6366F1', style: 'candidate', pressable: true });
      }
    }
    if (step === 'shape' && mode === 'street' && network) {
      for (const w of network.ways.values()) {
        out.push({ id: `way:${w.id}`, geometry: { type: 'LineString', coordinates: w.geometry.map((p) => [p.lon, p.lat]) }, color: '#6366F1', style: 'candidate' });
      }
    }
    if (mode === 'area' && picked) out.push({ id: 'draft', geometry: picked.geometry, color: accent, style: 'draft', selected: true });
    if (mode === 'street') {
      const g = segmentsToGeometry(allSegments.map((s) => s.line));
      if (g) out.push({ id: 'draft', geometry: g, color: accent, style: 'draft' });
      if (step === 'shape') {
        if (start) out.push({ id: 'handle-start', geometry: { type: 'Point', coordinates: [start.point.lon, start.point.lat] }, color: '#16A34A', style: 'draft', selected: !end });
        if (end) out.push({ id: 'handle-end', geometry: { type: 'Point', coordinates: [end.point.lon, end.point.lat] }, color: '#DC2626', style: 'draft' });
      }
    }
    if (mode === 'draw' && drawKind === 'points' && points.points.length) {
      const coords = points.points.map((p) => [p.lon, p.lat]);
      if (points.closed) out.push({ id: 'draft', geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]!]] }, color: accent, style: 'draft' });
      else if (coords.length >= 2) out.push({ id: 'draft', geometry: { type: 'LineString', coordinates: coords }, color: accent, style: 'candidate' });
      if (step === 'shape') {
        out.push({ id: 'vertices', geometry: { type: 'MultiPoint', coordinates: coords }, color: accent, style: 'draft' });
        const sel = points.selected !== null ? points.points[points.selected] : !points.closed ? points.points[0] : undefined;
        if (sel) out.push({ id: 'vertex-selected', geometry: { type: 'Point', coordinates: [sel.lon, sel.lat] }, color: points.selected !== null ? '#DC2626' : '#16A34A', style: 'draft', selected: true });
      }
    }
    if (mode === 'draw' && drawKind === 'paint' && painted) out.push({ id: 'draft', geometry: painted, color: accent, style: 'blurred' });
    return out;
  }, [step, mode, areas, picked, network, allSegments, start, end, drawKind, points, painted, c.accent]);

  const onShapePress = (id: string) => {
    if (mode !== 'area' || step !== 'shape') return;
    const a = areas.find((x) => `area:${x.osmType}/${x.osmId}` === id);
    if (a) pickArea(a, false);
  };

  // ---------------------------------------------------------------- next steps
  const alreadySaved = useMemo(() => {
    if (!result?.osm) return false;
    const s = repo.getMySaveForPlace(placeIdFromOsm(result.osm.osmType, result.osm.osmId));
    return !!s && s.deletedAt === null;
  }, [result, repo]);

  const useForList = () => {
    if (!result) return;
    let zone: FilterZone | null = null;
    const g = result.geometry;
    if (result.osm) zone = { kind: 'osm', osmType: result.osm.osmType, osmId: result.osm.osmId, name: result.osm.name, geometry: result.osm.geometry };
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') zone = { kind: 'drawn', name: result.name, geometry: g };
    else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const lines = (g.type === 'LineString' ? [g.coordinates] : (g as MultiLineString).coordinates).map((l) => l.map(([lon, lat]) => ({ lat: lat!, lon: lon! })));
      const area = bufferLines(lines, STREET_BUFFER_M);
      if (area) zone = { kind: 'drawn', name: result.name, geometry: area };
    }
    if (!zone) return;
    setPendingListZone(zone);
    back();
  };

  const save = (name: string, f: SaveFields) => {
    if (!result) return;
    const place = result.osm
      ? { osm: { type: result.osm.osmType, id: result.osm.osmId }, name, category: result.osm.category, kind: 'zone' as const, edge: result.edge, geometry: result.geometry }
      : { id: newLocalPlaceId(), name, category: null, kind: 'zone' as const, edge: result.edge, geometry: result.geometry };
    const id = mutate((s) =>
      s.putSave({
        place,
        tagIds: f.tagIds,
        mainTagId: f.tagIds[0] ?? null,
        status: f.status,
        priceLevel: f.priceLevel,
        comment: f.comment,
        commentVisibility: f.commentVisibility,
        sharing: f.sharing,
      }),
    );
    const placeId = repo.getSave(id)?.placeId ?? (result.osm ? placeIdFromOsm(result.osm.osmType, result.osm.osmId) : place.id!);
    focusPlace(placeId);
    if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  };

  // ---------------------------------------------------------------- UI
  const statusLine = (s: 'idle' | 'loading' | 'error' | 'zoom', zoomKey: string) =>
    s === 'loading' ? (
      <View style={styles.row}>
        <ActivityIndicator color={c.accent} />
        <Text style={{ color: c.textMuted }} maxFontSizeMultiplier={2}>
          {t('zone.loading')}
        </Text>
      </View>
    ) : s === 'error' ? (
      <Banner tone="warning">{t('zone.offline')}</Banner>
    ) : s === 'zoom' ? (
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {t(zoomKey)}
      </Text>
    ) : null;

  const problem = mode === 'draw' && drawKind === 'points' ? pointsProblem(points) : null;

  const tools = (
    <View style={{ gap: 10 }}>
      <Segmented
        options={[
          { value: 'area' as Mode, label: t('zone.mode.area') },
          { value: 'street' as Mode, label: t('zone.mode.street') },
          { value: 'draw' as Mode, label: t('zone.mode.draw') },
        ]}
        value={mode}
        onChange={setMode}
        testID="zone-mode"
      />

      {mode === 'area' && (
        <>
          <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {purpose === 'list' ? t('zone.area.hintList') : t('zone.area.hint')}
          </Text>
          <View style={styles.row}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => void runSearch()}
              placeholder={purpose === 'list' ? t('zone.area.searchList') : t('zone.area.search')}
              placeholderTextColor={c.textMuted}
              returnKeyType="search"
              style={[styles.input, styles.grow, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
              accessibilityLabel={t('zone.area.search')}
              testID="zone-area-search"
            />
            <Button kind="secondary" label={t('zone.area.go')} onPress={() => void runSearch()} disabled={searching || !query.trim()} testID="zone-area-go" />
          </View>
          {searching && <ActivityIndicator color={c.accent} />}
          {results && !searching && (
            <View style={styles.wrap}>
              {results.length === 0 ? (
                <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                  {t('zone.area.noResult')}
                </Text>
              ) : (
                results.map((a) => (
                  <Pill
                    key={`${a.osmType}/${a.osmId}`}
                    label={a.name}
                    selected={picked?.osmId === a.osmId}
                    onPress={() => pickArea(a, true)}
                    testID={`zone-result-${a.name}`}
                  />
                ))
              )}
            </View>
          )}
          {statusLine(areaStatus, 'zone.area.zoomIn')}
          {!results && areas.length > 0 && (
            <View style={styles.wrap}>
              {areas.map((a) => (
                <Pill key={`${a.osmType}/${a.osmId}`} label={a.name} selected={picked?.osmId === a.osmId} onPress={() => pickArea(a, false)} testID={`zone-area-${a.name}`} />
              ))}
            </View>
          )}
          <Text style={[styles.attrib, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
            {t('card.osmAttribution')}
          </Text>
        </>
      )}

      {mode === 'street' && (
        <>
          <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {!start ? (segments.length ? t('zone.street.hintNext') : t('zone.street.hintStart')) : !end ? t('zone.street.hintEnd') : t('zone.street.hintMove')}
          </Text>
          {streetMsg && <Banner tone="warning">{streetMsg}</Banner>}
          {statusLine(streetStatus, 'zone.street.zoomIn')}
          {allSegments.length > 0 && (
            <Text style={{ color: c.text }} maxFontSizeMultiplier={2} testID="zone-street-summary">
              {allSegments.map((s, i) => `${i + 1}. ${s.names.join(' / ') || t('zone.street.unnamed')} (${formatDistance(linesLengthM([s.line]), tr)})`).join('\n')}
            </Text>
          )}
          <View style={styles.wrap}>
            <Button kind="secondary" label={t('zone.street.add')} onPress={addSegment} disabled={currentPath.length < 2} testID="zone-street-add" />
            <Button kind="secondary" label={t('zone.undo')} onPress={undoSegment} disabled={!start && segments.length === 0} testID="zone-street-undo" />
          </View>
        </>
      )}

      {mode === 'draw' && (
        <>
          <Segmented
            options={[
              { value: 'points' as DrawKind, label: t('zone.draw.points') },
              { value: 'paint' as DrawKind, label: t('zone.draw.paint') },
            ]}
            value={drawKind}
            onChange={setDrawKind}
            testID="zone-draw-kind"
          />
          {drawKind === 'points' ? (
            <>
              <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {!points.closed
                  ? points.points.length >= 3
                    ? t('zone.points.hintClose')
                    : t('zone.points.hintAdd')
                  : points.selected !== null
                    ? t('zone.points.hintMoveTo')
                    : t('zone.points.hintEdit')}
              </Text>
              {problem === 'selfIntersecting' && <Banner tone="warning">{t('zone.points.selfIntersecting')}</Banner>}
              {problem === 'tooSmall' && <Banner tone="warning">{t('zone.points.tooSmall')}</Banner>}
              <View style={styles.wrap}>
                <Button
                  kind="secondary"
                  label={points.closed && points.selected !== null ? t('zone.points.removeVertex') : t('zone.undo')}
                  onPress={() => setPoints(undoPoint)}
                  disabled={points.points.length === 0}
                  testID="zone-points-undo"
                />
                <Button kind="secondary" label={t('zone.clear')} onPress={() => setPoints(EMPTY_POINTS)} disabled={points.points.length === 0} />
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {moveMap ? t('zone.paint.hintMove') : eraser ? t('zone.paint.hintErase') : t('zone.paint.hint')}
              </Text>
              <View style={styles.wrap}>
                {(['S', 'M', 'L'] as Brush[]).map((b) => (
                  <Pill key={b} label={t(`zone.paint.size${b}`)} selected={brush === b && !moveMap} onPress={() => { setBrush(b); setMoveMap(false); }} testID={`zone-brush-${b}`} />
                ))}
                <Pill label={t('zone.paint.eraser')} selected={eraser && !moveMap} onPress={() => { setEraser((e) => !e); setMoveMap(false); }} testID="zone-eraser" />
                <Pill label={t('zone.paint.moveMap')} selected={moveMap} onPress={() => setMoveMap((m) => !m)} testID="zone-move-map" />
              </View>
              <View style={styles.wrap}>
                <Button kind="secondary" label={t('zone.undo')} onPress={() => setStrokes((s) => s.slice(0, -1))} disabled={strokes.length === 0} testID="zone-paint-undo" />
                <Button kind="secondary" label={t('zone.clear')} onPress={() => setStrokes([])} disabled={strokes.length === 0} />
              </View>
            </>
          )}
        </>
      )}

      {result && (
        <Text style={{ color: c.text, fontWeight: '600' }} maxFontSizeMultiplier={2} testID="zone-result">
          {result.summary}
        </Text>
      )}
      <Button
        label={purpose === 'list' ? t('zone.useForList') : t('zone.next')}
        onPress={() => (purpose === 'list' ? useForList() : setStep('form'))}
        disabled={!result}
        testID="zone-next"
      />
    </View>
  );

  const panelStyle = wide
    ? { top: insets.top + 64, right: insets.right + gutter, width: sheetWidth, maxHeight: height - insets.top - insets.bottom - 96, borderRadius: 20 }
    : { left: 0, right: 0, bottom: 0, maxHeight: Math.round(height * (step === 'form' ? 0.75 : 0.46)), borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: insets.bottom + 12 };

  const painting = step === 'shape' && mode === 'draw' && drawKind === 'paint' && !moveMap;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]} onLayout={(e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      <Map
        styleUrl={dark ? MAP_STYLE_URL_DARK : MAP_STYLE_URL}
        center={initial.center}
        zoom={initial.zoom}
        camera={camera}
        pins={[]}
        shapes={shapes}
        onShapePress={onShapePress}
        onMapPress={onMapPress}
        onRegionChange={setRegion}
      />
      {painting && <PaintOverlay thickness={BRUSH_PX[brush]} eraser={eraser} color={c.accent} onStroke={onStroke} />}

      <View style={[styles.topBar, { paddingTop: insets.top + 8, paddingHorizontal: insets.left + gutter }]} pointerEvents="box-none">
        <Pressable onPress={back} style={[styles.chip, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={t('common.back')} testID="back">
          <Text style={{ color: c.accent, fontWeight: '700', fontSize: 15 }} maxFontSizeMultiplier={2}>
            ‹ {t('common.back')}
          </Text>
        </Pressable>
        <View style={[styles.chip, { backgroundColor: c.surface, borderColor: c.border, flexShrink: 1 }]}>
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }} accessibilityRole="header" maxFontSizeMultiplier={2} numberOfLines={1}>
            {purpose === 'list' ? t('zone.titleList') : t('zone.title')}
          </Text>
        </View>
        {OSM_FIXTURES && (
          <View style={{ flexShrink: 1 }} pointerEvents="none">
            <Banner>{t('osm.fixtureShort')}</Banner>
          </View>
        )}
      </View>

      <View style={[styles.panel, panelStyle, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow, paddingHorizontal: gutter + 4 }]} testID="zone-panel">
        <ScrollView contentContainerStyle={{ paddingVertical: 14 }} keyboardShouldPersistTaps="handled">
          {step === 'shape' || !result ? (
            tools
          ) : (
            <ZoneForm initialName={result.name} summary={result.summary} alreadySaved={alreadySaved} onBack={() => setStep('shape')} onSave={save} />
          )}
        </ScrollView>
      </View>

      <MapAttribution bottom={wide ? insets.bottom + 6 : Math.round(height * 0.46) + 6} right={insets.right + gutter / 2} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chip: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  panel: {
    position: 'absolute',
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  // A text field next to a button: shrinks, and the button wraps below with large text.
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 160, minWidth: 0 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: 14 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  attrib: { fontSize: 11 },
});
