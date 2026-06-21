/**
 * Hardened Yad2 real-estate scraper with per-agent dedup.
 *
 * Verified live: Yad2 GEO-restricts to Israeli IPs (a non-IL request gets a Radware bot challenge;
 * an Israeli IP gets real JSON). So this fetches through a FREE Israeli proxy (see countryProxy.ts)
 * — no API key needed. If a scraping-API key IS set (ZENROWS_API_KEY / SCRAPER_API_KEY) it uses that
 * instead (more reliable: residential IL IP + JS render). Listing extraction is defensive (recursive
 * finder over the page's __NEXT_DATA__ / feed JSON) so a markup change won't break it.
 *
 * Reality: free IL proxies are scarce + churny, so a scan can miss; callers fall back to web search.
 * For always-on reliability, set ZENROWS_API_KEY (IL residential) — everything else is identical.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { fetchViaCountry } from './countryProxy';

export interface Yad2Params { city?: string; maxPrice?: number; minPrice?: number; propertyType?: string; rooms?: number; }
export interface Yad2Listing { id: string; price: number | null; rooms: number | null; areaSqm: number | null; address: string; city: string; url: string; image?: string; }
export interface ScanResult { ok: boolean; blocked: boolean; error?: string; source: string; listings: Yad2Listing[]; totalMatched: number; }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Yad2 internal city codes for common cities (used in the search-page URL).
const CITY_CODES: Record<string, number> = {
  'תל אביב': 5000, 'תל אביב יפו': 5000, 'tel aviv': 5000, ירושלים: 3000, jerusalem: 3000, חיפה: 4000, haifa: 4000,
  'ראשון לציון': 8300, רחובות: 8400, נתניה: 7400, 'פתח תקווה': 7900, 'באר שבע': 9000, אשדוד: 70, אשקלון: 7100,
  חולון: 6600, 'בת ים': 6200, 'רמת גן': 8600, 'בני ברק': 6100, הרצליה: 6400, 'כפר סבא': 6900, רעננה: 8700,
  מודיעין: 1200, גבעתיים: 6300, אילת: 2600, נהריה: 9100,
};

const propIsRent = (p?: string): boolean => !!p && /שכיר|rent|להשכרה/i.test(p);

function searchPageUrl(params: Yad2Params): string {
  const path = propIsRent(params.propertyType) ? 'rent' : 'forsale';
  const qs = new URLSearchParams();
  const code = params.city ? CITY_CODES[params.city.trim().toLowerCase()] ?? CITY_CODES[params.city.trim()] : undefined;
  if (code) qs.set('city', String(code));
  if (params.maxPrice) qs.set('price', `${params.minPrice ?? 0}-${params.maxPrice}`);
  if (params.rooms) qs.set('rooms', `${params.rooms}-${params.rooms + 2}`);
  const q = qs.toString();
  return `https://www.yad2.co.il/realestate/${path}${q ? '?' + q : ''}`;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const pick = (o: any, ...keys: string[]): any => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return undefined; };

function normalize(raw: any): Yad2Listing | null {
  const id = String(pick(raw, 'orderId', 'token', 'id', 'adNumber', 'link_token') ?? '');
  if (!id) return null;
  const token = pick(raw, 'token', 'link_token', 'orderId', 'id');
  return {
    id,
    price: num(pick(raw, 'price', 'priceData.price', 'metaData.price')),
    rooms: num(pick(raw, 'rooms', 'Rooms_text', 'additionalDetails.roomsCount', 'address.house.rooms', 'row_4')),
    areaSqm: num(pick(raw, 'square_meters', 'squareMeter', 'additionalDetails.squareMeter', 'address.house.area')),
    address: String(pick(raw, 'title_1', 'address.street.text', 'address', 'row_1', 'neighborhood') ?? '').trim() || 'דירה',
    city: String(pick(raw, 'city', 'cityText', 'address.city.text', 'title_2', 'row_2') ?? '').trim(),
    url: token ? `https://www.yad2.co.il/item/${token}` : (pick(raw, 'canonical_url', 'link') ?? 'https://www.yad2.co.il/realestate/forsale'),
    image: pick(raw, 'images.0', 'image', 'metaData.coverImage', 'imageUrl', 'metaData.images.0'),
  };
}

const looksLikeListing = (x: any): boolean => !!x && typeof x === 'object' && ('price' in x) && ('token' in x || 'orderId' in x || 'id' in x || 'adNumber' in x);

/** Defensively pull listings out of the page's __NEXT_DATA__ / feed JSON by recursively finding the
 *  first arrays of listing-shaped objects — robust to Yad2 changing where the feed is nested. */
function extractListings(html: string): any[] {
  let root: any = null;
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { root = JSON.parse(m[1]); } catch { /* ignore */ } }
  if (!root) { try { root = JSON.parse(html); } catch { /* ignore */ } } // raw gw JSON case
  if (!root) return [];
  const out: any[] = [];
  const seen = new Set<any>();
  (function walk(o: any) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length && o.filter(looksLikeListing).length >= Math.max(1, Math.floor(o.length / 2))) out.push(...o.filter(looksLikeListing));
      else o.forEach(walk);
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(root);
  return out;
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

// --- Fetch the Yad2 search page from inside Israel (scraping-API key if set, else free IL proxy) ---
function scraperApiFetch(url: string): Promise<{ ok: boolean; body: string; source: string }> {
  const zen = process.env.ZENROWS_API_KEY, sapi = process.env.SCRAPER_API_KEY;
  const fetchUrl = zen
    ? `https://api.zenrows.com/v1/?apikey=${zen}&antibot=true&js_render=true&proxy_country=il&url=${encodeURIComponent(url)}`
    : `https://api.scraperapi.com/?api_key=${sapi}&render=true&country_code=il&url=${encodeURIComponent(url)}`;
  return new Promise((resolve) => {
    execFile('curl', ['-s', '--max-time', '60', '-A', UA, fetchUrl], { timeout: 63000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const body = String(stdout ?? '');
      resolve({ ok: !err && (body.includes('__NEXT_DATA__') || body.trim().startsWith('{')) && !body.includes('__uzdbm'), body, source: zen ? 'zenrows' : 'scraperapi' });
    });
  });
}

async function fetchYad2(url: string): Promise<{ ok: boolean; blocked: boolean; body: string; source: string; error?: string }> {
  if (process.env.ZENROWS_API_KEY || process.env.SCRAPER_API_KEY) {
    const r = await scraperApiFetch(url);
    return { ok: r.ok, blocked: !r.ok, body: r.body, source: r.source, error: r.ok ? undefined : 'scraping-API returned a challenge/empty response' };
  }
  // Free Israeli proxy (geo-bypass). Yad2 only answers IL IPs.
  const r = await fetchViaCountry('IL', url, {
    headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://www.yad2.co.il/' },
    timeoutMs: 16000,
    accept: (b) => (b.includes('__NEXT_DATA__') || b.trim().startsWith('{')) && !b.includes('__uzdbm'),
  });
  return { ok: r.ok, blocked: !r.ok, body: r.body, source: 'il-proxy' + (r.proxy ? ` (${r.proxy})` : ''), error: r.error };
}

/** Scan Yad2 for matching listings and return only the ones NOT seen before for this agent. */
export async function scanYad2New(agentId: string, params: Yad2Params, limit = 15): Promise<ScanResult> {
  const fetched = await fetchYad2(searchPageUrl(params));
  if (!fetched.ok) return { ok: false, blocked: true, source: fetched.source, listings: [], totalMatched: 0, error: fetched.error };
  const all = extractListings(fetched.body).map(normalize).filter((l): l is Yad2Listing => !!l).filter((l) => matches(l, params));
  if (!all.length) return { ok: false, blocked: false, source: fetched.source, listings: [], totalMatched: 0, error: 'reached Yad2 but extracted no matching listings (markup/params)' };
  const seen = loadSeen(agentId);
  const fresh = all.filter((l) => !seen.has(l.id));
  for (const l of fresh) seen.add(l.id);
  if (fresh.length) saveSeen(agentId, seen);
  return { ok: true, blocked: false, source: fetched.source, listings: fresh.slice(0, limit), totalMatched: all.length };
}

export function formatListings(listings: Yad2Listing[]): string {
  return listings
    .map((l) => `🏠 ${l.address}${l.city ? ', ' + l.city : ''} — ${l.price ? '₪' + l.price.toLocaleString() : 'מחיר לא צוין'}${l.rooms ? ` · ${l.rooms} חד'` : ''}${l.areaSqm ? ` · ${l.areaSqm} מ"ר` : ''}\n${l.url}`)
    .join('\n\n');
}

export function isYad2Context(text: string): boolean {
  return /yad2|יד ?2|דירות|דירה|נדל"?ן|apartment|real ?estate|למכירה|להשכרה/i.test(text);
}

// Re-export the generic test helpers via the listing extractor for unit tests.
export const _internal = { extractListings, normalize, matches, searchPageUrl };
