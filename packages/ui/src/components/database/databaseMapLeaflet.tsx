import React, {useEffect, useRef} from 'react';
import L from 'leaflet';
import {MapContainer, TileLayer, useMap} from 'react-leaflet';
import 'leaflet.markercluster';
// Leaflet (and the marker-cluster plugin) ship their own stylesheets. They're
// imported HERE (in the lazily-loaded chunk) rather than globally so non-map
// views never pay for them, and so they can't run during Next.js SSR (this whole
// module is dynamically imported client-side). Leaflet's sheets are namespaced
// under `.leaflet-*`/`.marker-cluster*` (they don't reset bare tags), and the map
// mounts inside an `.ob-leaflet` wrapper with `contain: paint` (see
// `databaseMap.tsx`) so its absolutely-positioned panes can't escape the card or
// fight the design system — the same shape `DataflowView` uses for React Flow.
// The cluster bubble itself is restyled to the warm-minimal system in index.css
// (`.ob-map-cluster`), so we deliberately do NOT import MarkerCluster.Default.css.
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import type {DatabaseRow} from '@book.dev/sdk';

/** A row resolved to a placed marker, pre-coloured by its group. */
export interface PlacedMarker {
  row: DatabaseRow;
  lat: number;
  lng: number;
  /** The hex colour from the group-by swatch (or a neutral default). */
  color: string;
  /** Marker tooltip / aria label. */
  label: string;
}

/**
 * A teardrop pin tinted to the row's group colour, built as an inline-SVG
 * `divIcon` (no external image assets, so it works offline and never 404s like
 * Leaflet's default bundler-broken marker images).
 */
const pinIcon = (color: string): L.DivIcon =>
  L.divIcon({
    className: 'ob-map-pin',
    html: `<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M11 0C5 0 0 4.6 0 10.4 0 18 11 30 11 30s11-12 11-19.6C22 4.6 17 0 11 0z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>
      <circle cx="11" cy="10.5" r="3.6" fill="#ffffff"/>
    </svg>`,
    iconSize: [22, 30],
    iconAnchor: [11, 30],
    tooltipAnchor: [0, -28],
  });

/** A neutral count bubble for a cluster, styled by `.ob-map-cluster` in index.css. */
const clusterIcon = (cluster: L.MarkerCluster): L.DivIcon => {
  const count = cluster.getChildCount();
  // Scale the bubble a touch with magnitude so dense clusters read as larger.
  const size = count < 10 ? 32 : count < 100 ? 38 : 44;
  return L.divIcon({
    html: `<div class="ob-map-cluster" style="width:${size}px;height:${size}px">${count}</div>`,
    className: 'ob-map-cluster-wrap',
    iconSize: [size, size],
  });
};

/** A stable signature of the placed coordinate set (order-independent). */
const markerSignature = (markers: PlacedMarker[]): string =>
  markers
    .map((m) => `${m.lat.toFixed(5)},${m.lng.toFixed(5)},${m.color}`)
    .sort()
    .join('|');

/**
 * Fit the map to the marker bounds — but only when the coordinate SET actually
 * changes, not on every parent re-render. Without the signature guard an
 * unrelated render (a row edit elsewhere, a resize) would snap the view back and
 * the user could never pan/zoom freely.
 */
const FitBounds: React.FC<{markers: PlacedMarker[]}> = ({markers}) => {
  const map = useMap();
  const sig = markerSignature(markers);
  const last = useRef<string>('');
  useEffect(() => {
    if (sig === last.current || markers.length === 0) return;
    last.current = sig;
    if (markers.length === 1) {
      map.setView([markers[0].lat, markers[0].lng], 12);
      return;
    }
    const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng] as [number, number]));
    map.fitBounds(bounds, {padding: [40, 40], maxZoom: 14});
    // Deps are intentional: `markers` content is captured by `sig`.
  }, [map, sig]);
  return null;
};

/**
 * The marker layer, driven imperatively through the maintained vanilla
 * `leaflet.markercluster` plugin (react-leaflet 5 / React 19 compatible, unlike
 * the abandoned react-leaflet-cluster wrapper). One tinted pin per placed row;
 * at low zoom dense pins collapse into neutral count bubbles. Click → open row.
 * Rebuilds only when the coordinate set or clustering toggle changes.
 */
const MarkersLayer: React.FC<{markers: PlacedMarker[]; clustered: boolean; onOpen: (rowId: string) => void}> = ({
  markers,
  clustered,
  onOpen,
}) => {
  const map = useMap();
  // Keep the open handler in a ref so changing its identity doesn't rebuild the
  // whole layer (the parent passes a fresh `db.openRow` closure each render).
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const sig = markerSignature(markers);

  useEffect(() => {
    const layer: L.LayerGroup = clustered
      ? L.markerClusterGroup({
        chunkedLoading: true,
        showCoverageOnHover: false,
        maxClusterRadius: 56,
        iconCreateFunction: clusterIcon,
      })
      : L.layerGroup();

    for (const m of markers) {
      const marker = L.marker([m.lat, m.lng], {icon: pinIcon(m.color), title: m.label, keyboard: true});
      marker.bindTooltip(m.label, {direction: 'top', offset: [0, -28]});
      marker.on('click', () => openRef.current(m.row.id));
      layer.addLayer(marker);
    }
    map.addLayer(layer);
    return () => {
      map.removeLayer(layer);
    };
    // `sig` captures the meaningful marker content; rebuild on it or the toggle
    // (`onOpen` is read through a ref, so its identity churn doesn't rebuild).
  }, [map, sig, clustered]);

  return null;
};

/**
 * The Leaflet map itself: OpenStreetMap raster tiles + the marker layer. Lazily
 * loaded by {@link MapView} so Leaflet's bundle + CSS only arrive with a real map
 * view and never during SSR.
 */
const LeafletMap: React.FC<{markers: PlacedMarker[]; clustered: boolean; onOpen: (rowId: string) => void}> = ({
  markers,
  clustered,
  onOpen,
}) => (
  <MapContainer
    // A sane default centre/zoom; FitBounds overrides it once markers exist.
    center={[20, 0]}
    zoom={2}
    scrollWheelZoom
    className="h-full w-full"
  >
    <TileLayer
      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      maxZoom={19}
    />
    <MarkersLayer markers={markers} clustered={clustered} onOpen={onOpen} />
    <FitBounds markers={markers} />
  </MapContainer>
);

export default LeafletMap;
