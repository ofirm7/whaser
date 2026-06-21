/**
 * Hardened Yad2 real-estate scraper with per-agent dedup.
 *
 * Reality check (verified live 2026): yad2.co.il sits behind Radware Bot Manager. Direct HTTP from a
 * datacenter IP returns a 302 JS challenge (the `__uzdbm_*` script) — no plain client can pass it.
 * So the fetcher is PLUGGABLE: if a scraping-API key is configured it routes through a residential /
 * JS-rendering proxy (real bypass); otherwise it reports `blocked` and the caller falls back to
 * web search. Everything else — normalization, city/price/type filtering, and dedup — is real and
 * works the moment the fetch succeeds.
 *
 * To go fully live, set ONE env var in apps/web/.env:
 *   ZENROWS_API_KEY=...      (https://www.zenrows.com — antibot + residential, recommended for Radware)
 *   # or
 *   SCRAPER_API_KEY=...      (https://www.scraperapi.com — render + IL geo)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Yad2Params {
  city?: string;
  maxPrice?: number;
  minPrice?: number;
  propertyType?: string; // 'מכירה' | 'שכירות' | 'sale' | 'rent'
  rooms?: number;
}

export interface Yad2Listing {
  id: string;
  price: number | null;
  rooms: number | null;
  areaSqm: number | null;
  address: string;
  city: string;
  url: string;
  image?: string;
}

export interface ScanResult {
  blocked: boolean;
  error?: string;
  source: 'zenrows' | 'scraperapi' | 'direct';
  listings: Yad2Listing[]; // NEW (unseen) listings only, after dedup
  totalMatched: number;
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://www.yad2.co.il/realestate/forsale',
};

// Yad2 internal city codes for the most common cities (the address-autocomplete API is also
// bot-blocked, so a static map is the robust path; unknown cities fall back to client-side filtering).
const CITY_CODES: Record<string, number> = {
  'תל אביב': 5000, 'תל אביב יפו': 5000, 'tel aviv': 5000,
  ירושלים: 3000, jerusalem: 3000,
  חיפה: 4000, haifa: 4000,
  'ראשון לציון': 8300, רחובות: 8400, נתניה: 7400, 'פתח תקווה': 7900,
  'באר שבע': 9000, אשדוד: 70, אשקלון: 7100, חולון: 6600, 'בת ים': 6200,
  'רמת גן': 8600, 'בני ברק': 6100, הרצליה: 6400, 'כפר סבא': 6900, רעננה: 8700,
  'מודיעין מכבים רעות': 1200, מודיעין: 1200, 'גבעתיים': 6300, אילת: 2600, נהריה: 9100,
};

const propIsRent = (p?: string): boolean => !!p && /שכיר|rent|להשכרה/i.test(p);

function feedUrl(params: Yad2Params): string {
  // gw.yad2.co.il is Yad2's JSON feed gateway. forsale vs rent path by property type.
  const base = `https://gw.yad2.co.il/realestate-feed/${propIsRent(params.propertyType) ? 'rent' : 'forsale'}/map`;
  const qs = new URLSearchParams();
  const code = params.city ? CITY_CODES[params.city.trim().toLowerCase()] ?? CITY_CODES[params.city.trim()] : undefined;
  if (code) qs.set('city', String(code));
  if (params.maxPrice) qs.set('price', `${params.minPrice ?? 0}-${params.maxPrice}`);
  if (params.rooms) qs.set('rooms', `${params.rooms}-${params.rooms + 2}`);
  qs.set('forceLdLoad', 'true');
  return `${base}?${qs.toString()}`;
}

function wrap(url: string): { fetchUrl: string; source: ScanResult['source'] } {
  const zen = process.env.ZENROWS_API_KEY;
  const sapi = process.env.SCRAPER_API_KEY;
  if (zen) return { fetchUrl: `https://api.zenrows.com/v1/?apikey=${zen}&antibot=true&js_render=true&proxy_country=il&url=${encodeURIComponent(url)}`, source: 'zenrows' };
  if (sapi) return { fetchUrl: `https://api.scraperapi.com/?api_key=${sapi}&render=true&country_code=il&url=${encodeURIComponent(url)}`, source: 'scraperapi' };
  return { fetchUrl: url, source: 'direct' };
}

const isChallenge = (body: string): boolean => body.includes('__uzdbm') || body.includes('Radware') || /<title>\s*302 Found/i.test(body) || body.trimStart().startsWith('<');

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const pick = (o: any, ...keys: string[]): any => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return undefined; };

/** Defensive normalizer — Yad2's feed nests listings under a few possible shapes; pull fields by
 *  several candidate keys so a minor shape change doesn't break extraction. */
function normalize(raw: any): Yad2Listing | null {
  const id = String(pick(raw, 'orderId', 'id', 'token', 'adNumber', 'link_token') ?? '');
  if (!id) return null;
  const token = pick(raw, 'token', 'link_token', 'orderId', 'id');
  return {
    id,
    price: num(pick(raw, 'price', 'priceData.price', 'metaData.price')),
    rooms: num(pick(raw, 'rooms', 'Rooms_text', 'additionalDetails.roomsCount', 'row_4')),
    areaSqm: num(pick(raw, 'square_meters', 'squareMeter', 'additionalDetails.squareMeter')),
    address: String(pick(raw, 'title_1', 'address', 'row_1', 'neighborhood') ?? '').trim() || 'דירה',
    city: String(pick(raw, 'city', 'cityText', 'title_2', 'row_2') ?? '').trim(),
    url: token ? `https://www.yad2.co.il/item/${token}` : (pick(raw, 'canonical_url', 'link') ?? 'https://www.yad2.co.il/realestate/forsale'),
    image: pick(raw, 'images.0', 'image', 'metaData.coverImage', 'imageUrl'),
  };
}

function extractListings(json: any): any[] {
  // Try the common containers Yad2 has used for the map/feed payload.
  const candidates = [json?.data?.markers, json?.data?.feed?.feed_items, json?.data?.feed_items, json?.feed_items, json?.markers, json?.data?.items, json?.items, Array.isArray(json) ? json : null];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  return [];
}

function matches(l: Yad2Listing, p: Yad2Params): boolean {
  if (p.maxPrice && l.price != null && l.price > p.maxPrice) return false;
  if (p.minPrice && l.price != null && l.price < p.minPrice) return false;
  if (p.city) { const c = p.city.trim(); if (l.city && !l.city.includes(c) && !l.address.includes(c)) return false; }
  return true;
}

// --- Per-agent dedup (persisted seen listing ids) ---
const seenFile = (agentId: string): string => fileURLToPath(new URL(`../.data/yad2-seen-${agentId.replace(/[^a-z0-9_-]/gi, '_')}.json`, import.meta.url));
function loadSeen(agentId: string): Set<string> {
  try { const a = JSON.parse(readFileSync(seenFile(agentId), 'utf8')); if (Array.isArray(a)) return new Set(a); } catch { /* ignore */ }
  return new Set();
}
function saveSeen(agentId: string, seen: Set<string>): void {
  try { const f = seenFile(agentId); const d = dirname(f); if (!existsSync(d)) mkdirSync(d, { recursive: true }); writeFileSync(f, JSON.stringify([...seen].slice(-5000))); } catch { /* ignore */ }
}

/** Scan Yad2 for matching listings and return only the ones NOT seen before for this agent. */
export async function scanYad2New(agentId: string, params: Yad2Params, limit = 15): Promise<ScanResult> {
  const { fetchUrl, source } = wrap(feedUrl(params));
  let body: string;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(fetchUrl, { headers: BROWSER_HEADERS, signal: ctrl.signal });
    clearTimeout(t);
    body = await res.text();
    if ((source === 'direct' && (res.status === 302 || isChallenge(body))) || (source !== 'direct' && isChallenge(body))) {
      return { blocked: true, source, listings: [], totalMatched: 0, error: 'Radware anti-bot challenge' };
    }
  } catch (e) {
    return { blocked: source === 'direct', source, listings: [], totalMatched: 0, error: e instanceof Error ? e.message : String(e) };
  }
  let json: unknown;
  try { json = JSON.parse(body); } catch { return { blocked: true, source, listings: [], totalMatched: 0, error: 'non-JSON response (challenge/HTML)' }; }

  const all = extractListings(json).map(normalize).filter((l): l is Yad2Listing => !!l).filter((l) => matches(l, params));
  const seen = loadSeen(agentId);
  const fresh = all.filter((l) => !seen.has(l.id));
  for (const l of fresh) seen.add(l.id);
  if (fresh.length) saveSeen(agentId, seen);
  return { blocked: false, source, listings: fresh.slice(0, limit), totalMatched: all.length };
}

export function formatListings(listings: Yad2Listing[]): string {
  return listings
    .map((l) => `🏠 ${l.address}${l.city ? ', ' + l.city : ''} — ${l.price ? '₪' + l.price.toLocaleString() : 'מחיר לא צוין'}${l.rooms ? ` · ${l.rooms} חד'` : ''}${l.areaSqm ? ` · ${l.areaSqm} מ"ר` : ''}\n${l.url}`)
    .join('\n\n');
}

/** True when a tool/agent is about Yad2 real-estate, so its read/search tool should use the scraper. */
export function isYad2Context(text: string): boolean {
  return /yad2|יד ?2|דירות|דירה|נדל"?ן|apartment|real ?estate|למכירה|להשכרה/i.test(text);
}
