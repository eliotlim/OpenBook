import type {LocationValue} from '@book.dev/sdk';

/**
 * Opt-in, cached address → coordinate geocoding for the map view.
 *
 * **Local-first contract.** Geocoding is the *one* place the database makes a
 * network call, so it never happens implicitly: a view only hits the network
 * when the user explicitly presses "Geocode addresses" in the map's unplaced
 * affordance. Results are cached in `localStorage` keyed by the normalised
 * address so a re-rendered view (or a second view over the same rows) reads the
 * cache instead of re-querying — repeated views never re-hit the network.
 *
 * The geocoder is the public OpenStreetMap **Nominatim** endpoint (no API key,
 * the same project whose raster tiles the map renders). Its usage policy asks
 * for a descriptive `User-Agent`/`Referer` and at most one request per second;
 * we serialise lookups and identify the app accordingly.
 *
 * > TODO(T8, server route): the design doc (§1) prefers a **server-side**
 * > geocoding proxy that caches address→coords in a dedicated table, so the
 * > cache is shared across devices and the network egress is centralised.
 * > That needs a new SDK `API` entry + `HttpDataClient` method + a Hono route
 * > in `server/src/app.ts` + a migration — all outside this change's file
 * > scope (and `app.ts` is shared with concurrent AI work). This client-side
 * > localStorage cache is the local-first stand-in; swap `geocodeAddress`'s
 * > body for a `client.geocode(address)` call when the route lands.
 */

const CACHE_KEY = 'ob.geocode.cache.v1';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/** A cached miss is recorded as `null` so we don't retry hopeless addresses. */
type CacheEntry = {lat: number; lng: number} | null;

const normalize = (address: string): string => address.trim().toLowerCase().replace(/\s+/g, ' ');

function readCache(): Record<string, CacheEntry> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota / private mode — geocoding still works, just uncached. */
  }
}

/** A cached coordinate for an address without touching the network, or `undefined`
 *  when the address has never been looked up. A cached miss reads as `null`. */
export function cachedGeocode(address: string): CacheEntry | undefined {
  const key = normalize(address);
  if (!key) return null;
  const cache = readCache();
  return key in cache ? cache[key] : undefined;
}

/**
 * Geocode one address to coordinates, consulting the cache first. Returns null
 * for an unresolvable address (also cached, to avoid retry storms). Only called
 * behind an explicit user action — never during a passive render.
 */
export async function geocodeAddress(address: string): Promise<{lat: number; lng: number} | null> {
  const key = normalize(address);
  if (!key) return null;
  const cache = readCache();
  if (key in cache) return cache[key];

  let result: CacheEntry = null;
  try {
    const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, {headers: {Accept: 'application/json'}});
    if (res.ok) {
      const hits = (await res.json()) as {lat: string; lon: string}[];
      const hit = hits[0];
      if (hit) {
        const lat = Number(hit.lat);
        const lng = Number(hit.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) result = {lat, lng};
      }
    }
  } catch {
    // Network failure: don't cache (let the user retry); fall through to null.
    return null;
  }

  cache[key] = result;
  writeCache(cache);
  return result;
}

/** Build the {@link LocationValue} for a geocoded address (keeps the source string). */
export function locationFromGeocode(address: string, coords: {lat: number; lng: number}): LocationValue {
  return {lat: coords.lat, lng: coords.lng, address: address.trim()};
}
