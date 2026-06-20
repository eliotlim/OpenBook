import React, {Suspense, lazy, useState} from 'react';
import {MapPin} from 'lucide-react';
import {
  groupRowsBy,
  rowLocation,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
} from '@open-book/sdk';
import {cn} from '@/lib/utils';
import {readPageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import type {UseDatabase} from './useDatabase';
import {SWATCH_HEX} from './databaseColors';
import {RowChips, RowContextMenu} from './databaseLayouts';
import {cachedGeocode, geocodeAddress, locationFromGeocode} from './geocode';
import type {PlacedMarker} from './databaseMapLeaflet';

// The Leaflet map is a separate chunk: it (and its CSS) only load with a real map
// view, and never during SSR (Leaflet touches `window` at import time).
const LeafletMap = lazy(() => import('./databaseMapLeaflet'));

/** Neutral pin colour for rows whose group carries no swatch (or no grouping). */
const DEFAULT_PIN = SWATCH_HEX.blue;

const Hint: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>
);

/**
 * Map view: rows with resolvable coordinates rendered as markers on Leaflet +
 * OpenStreetMap raster tiles. Markers are coloured by the view's
 * `groupByPropertyId` (shared with every other layout via {@link groupRowsBy} +
 * {@link SWATCH_HEX}), with a legend below the map and clustering at low zoom for
 * dense data. Clicking a marker opens the row (the same affordance other views
 * use). Rows without coordinates collect into an "unplaced" affordance — which,
 * when an address property is configured, can geocode them on demand (opt-in,
 * cached — see `geocode.ts`) rather than silently dropping them.
 */
export const MapView: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  /** The view's visible property set, shown as chips in the unplaced list. */
  cardProperties?: DatabaseProperty[];
}> = ({db, view, properties, cardProperties}) => {
  const geoProp = view.geoPropertyId ? properties.find((p) => p.id === view.geoPropertyId) : undefined;

  if (!geoProp) {
    return <Hint>Choose a location property in the view options to place rows on a map.</Hint>;
  }

  // Colour each placed row by its group (the same grouping every layout uses).
  const groups = groupRowsBy(db.visibleRows, view.groupByPropertyId, properties);
  const colorByRow = new Map<string, string>();
  const usedGroups: {key: string; label: string; color: string}[] = [];
  for (const g of groups) {
    const color = g.color ? SWATCH_HEX[g.color] ?? DEFAULT_PIN : DEFAULT_PIN;
    let placedInGroup = 0;
    for (const row of g.rows) {
      if (rowLocation(row, view, properties)) {
        colorByRow.set(row.id, color);
        placedInGroup += 1;
      }
    }
    // The legend lists only groups that actually contribute a marker.
    if (view.groupByPropertyId && placedInGroup > 0) usedGroups.push({key: g.key, label: g.label, color});
  }

  const placed: PlacedMarker[] = [];
  const unplaced: DatabaseRow[] = [];
  for (const row of db.visibleRows) {
    const loc = rowLocation(row, view, properties);
    if (loc) {
      placed.push({
        row,
        lat: loc.lat,
        lng: loc.lng,
        color: colorByRow.get(row.id) ?? DEFAULT_PIN,
        label: row.name?.trim() || 'Untitled',
      });
    } else {
      unplaced.push(row);
    }
  }

  return (
    <div className="space-y-3">
      {placed.length === 0 ? (
        <Hint>
          No rows have coordinates yet. Set the {geoProp.name} property on a row (or geocode an address below) to place it on the map.
        </Hint>
      ) : (
        // `.ob-leaflet` + `contain: paint` keep Leaflet's absolutely-positioned
        // panes from escaping the card; `overflow-hidden` clips the tile layer to
        // the rounded border. (Leaflet's sheet is `.leaflet-*`-namespaced, so it
        // doesn't bleed into the app — see the import note in databaseMapLeaflet.)
        <div className="ob-leaflet h-[480px] overflow-hidden rounded-md border border-border" style={{contain: 'paint'}}>
          <Suspense fallback={<div className="ob-skeleton h-full w-full" aria-label="Loading map" />}>
            <LeafletMap markers={placed} clustered={view.mapClustered !== false} onOpen={(id) => db.openRow(id)} />
          </Suspense>
        </div>
      )}

      {usedGroups.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {usedGroups.map((g) => (
            <span key={g.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: g.color}} />
              {g.label}
            </span>
          ))}
        </div>
      )}

      {unplaced.length > 0 && (
        <UnplacedRows db={db} view={view} properties={properties} cardProperties={cardProperties} rows={unplaced} />
      )}
    </div>
  );
};

/**
 * The "unplaced (N)" affordance: rows the map couldn't place, listed (rather than
 * dropped) so they're visible and actionable. When the view names an address
 * property, a "Geocode" button looks each row's address up — explicitly,
 * on demand, and cached (`geocode.ts`) — and writes the resulting coordinates
 * into the location property so the row appears on the map.
 */
const UnplacedRows: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  cardProperties?: DatabaseProperty[];
  rows: DatabaseRow[];
}> = ({db, view, properties, cardProperties, rows}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const geoProp = view.geoPropertyId ? properties.find((p) => p.id === view.geoPropertyId) : undefined;
  const addressProp = view.addressPropertyId ? properties.find((p) => p.id === view.addressPropertyId) : undefined;
  const chipProps = (cardProperties ?? []).filter((p) => p.id !== geoProp?.id && p.id !== addressProp?.id);

  /** The geocodable address text for a row (the configured address column). */
  const addressOf = (row: DatabaseRow): string => {
    if (!addressProp) return '';
    const raw = row.properties[addressProp.id];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const geocodable = addressProp ? rows.filter((r) => addressOf(r) && !cachedGeocode(addressOf(r))) : [];

  const runGeocode = async (): Promise<void> => {
    if (!geoProp || !addressProp || busy) return;
    setBusy(true);
    setNote(null);
    let placed = 0;
    for (const row of rows) {
      const address = addressOf(row);
      if (!address) continue;
      const coords = await geocodeAddress(address); // serialised: respects OSM's rate policy
      if (coords) {
        await db.setRowProperty(row.id, geoProp.id, locationFromGeocode(address, coords));
        placed += 1;
      }
    }
    setBusy(false);
    setNote(placed > 0 ? `Placed ${placed} of ${rows.length}.` : 'No addresses could be resolved.');
  };

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <MapPin className="h-3.5 w-3.5" />
          Unplaced ({rows.length})
        </button>
        {note && <span className="text-xs text-muted-foreground/70">{note}</span>}
        {addressProp && geoProp && (
          <button
            onClick={() => void runGeocode()}
            disabled={busy || geocodable.length === 0}
            className={cn(
              'ml-auto rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
              (busy || geocodable.length === 0) && 'opacity-40',
            )}
            title={`Look up coordinates from ${addressProp.name} (a network call)`}
          >
            {busy ? 'Geocoding…' : `Geocode ${addressProp.name}`}
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-60 space-y-0.5 overflow-y-auto border-t border-border px-2 py-1.5">
          {rows.map((row) => (
            <RowContextMenu key={row.id} db={db} rowId={row.id}>
              <button
                onClick={() => db.openRow(row.id)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-hover"
              >
                <PageIcon value={readPageIcon(row.id)} className="shrink-0 text-sm leading-none" />
                <span className="truncate">{row.name?.trim() || 'Untitled'}</span>
                {chipProps.length > 0 && (
                  <span className="ml-1 min-w-0 flex-1 overflow-hidden">
                    <RowChips row={row} properties={chipProps} rows={db.rows} />
                  </span>
                )}
              </button>
            </RowContextMenu>
          ))}
        </div>
      )}
    </div>
  );
};

export default MapView;
