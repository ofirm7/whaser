/**
 * Free country-scoped egress for geo-restricted sites.
 *
 * Some sites only serve a given country (e.g. Yad2 only answers Israeli IPs). This module fetches a
 * URL through a FREE proxy located in the requested country — aggregating candidates from several
 * public free-proxy sources, validating them concurrently against the real target, caching the live
 * one, and rotating on failure. No API key, no paid service.
 *
 * Caveat: free proxies are inherently churny/slow, so success isn't guaranteed every call; callers
 * should treat a miss as "temporarily unavailable" and fall back. Uses the system `curl` (native
 * SOCKS5/HTTP proxy + TLS) so there are no extra dependencies.
 */
import { execFile } from 'node:child_process';

export interface ProxyFetch {
  ok: boolean;
  status: number;
  body: string;
  proxy?: string;
  error?: string;
}

const cache = new Map<string, { proxy: string; at: number }>(); // country -> last-known-good proxy
const TTL_MS = 8 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function curl(args: string[], timeoutMs: number): Promise<{ code: number; body: string; status: number }> {
  return new Promise((resolve) => {
    execFile('curl', args, { timeout: timeoutMs + 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout ?? '');
      const m = out.match(/\n?\|HTTP (\d+)\s*$/);
      const status = m ? Number(m[1]) : 0;
      const body = out.replace(/\n?\|HTTP \d+\s*$/, '');
      resolve({ code: err ? 1 : 0, body, status });
    });
  });
}

async function proxiedCurl(url: string, proxy: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  const args = ['-s', '-x', proxy, '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', UA];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('-w', '\n|HTTP %{http_code}', url);
  const r = await curl(args, timeoutMs);
  return { status: r.status, body: r.body };
}

/** Aggregate free proxies for an ISO country code from several public sources (best-effort). */
async function fetchCandidates(cc: string): Promise<string[]> {
  const C = cc.toUpperCase();
  const sources: Array<() => Promise<string[]>> = [
    async () => {
      const r = await curl(['-s', '--max-time', '15', '-A', UA, `https://proxylist.geonode.com/api/proxy-list?limit=80&country=${C}&protocols=socks5%2Chttp%2Chttps&sort_by=lastChecked&sort_type=desc`], 16000);
      const d = JSON.parse(r.body);
      return (d.data ?? []).map((p: any) => `${(p.protocols ?? []).includes('socks5') ? 'socks5h' : 'http'}://${p.ip}:${p.port}`);
    },
    async () => {
      const r = await curl(['-s', '--max-time', '15', '-A', UA, `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${C.toLowerCase()}&proxy_format=protocolipport&format=text`], 16000);
      return r.body.split(/\s+/).filter((l) => /:\/\//.test(l)).map((l) => l.replace('socks5://', 'socks5h://'));
    },
    async () => {
      const r = await curl(['-s', '--max-time', '15', '-A', UA, `https://www.proxy-list.download/api/v1/get?type=https&country=${C}`], 16000);
      return r.body.split(/\s+/).filter(Boolean).map((hp) => `http://${hp}`);
    },
  ];
  const lists = await Promise.all(sources.map((s) => s().catch(() => [] as string[])));
  return [...new Set(lists.flat().filter((p) => /^(socks5h|http):\/\/\d{1,3}(\.\d{1,3}){3}:\d+$/.test(p)))];
}

const looksValid = (body: string): boolean => !body.includes('__uzdbm') && !body.includes('Radware') && !/<title>\s*302/i.test(body) && body.trim() !== '';

/**
 * Fetch `url` from inside `cc` (e.g. 'IL'). Tries the cached live proxy first, then validates fresh
 * candidates concurrently against the real target until one returns a non-challenge response.
 * `accept(body,status)` decides what counts as a usable response (default: any non-challenge body).
 */
export async function fetchViaCountry(
  cc: string,
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; accept?: (body: string, status: number) => boolean } = {},
): Promise<ProxyFetch> {
  const headers = { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8', ...(opts.headers ?? {}) };
  const timeoutMs = opts.timeoutMs ?? 12000;
  const accept = opts.accept ?? ((b) => looksValid(b));

  // 1) Try the cached known-good proxy.
  const hit = cache.get(cc);
  if (hit && Date.now() - hit.at < TTL_MS) {
    const r = await proxiedCurl(url, hit.proxy, headers, timeoutMs).catch(() => ({ status: 0, body: '' }));
    if (r.status && accept(r.body, r.status)) { cache.set(cc, { proxy: hit.proxy, at: Date.now() }); return { ok: true, ...r, proxy: hit.proxy }; }
    cache.delete(cc);
  }

  // 2) Discover + validate fresh candidates in small concurrent batches; first good one wins + caches.
  const candidates = await fetchCandidates(cc);
  if (!candidates.length) return { ok: false, status: 0, body: '', error: `no free ${cc} proxies available right now` };
  const BATCH = 8;
  for (let i = 0; i < candidates.length && i < 40; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (p) => {
        const r = await proxiedCurl(url, p, headers, timeoutMs).catch(() => ({ status: 0, body: '' }));
        return { p, ...r };
      }),
    );
    const good = results.find((r) => r.status && accept(r.body, r.status));
    if (good) { cache.set(cc, { proxy: good.p, at: Date.now() }); return { ok: true, status: good.status, body: good.body, proxy: good.p }; }
  }
  return { ok: false, status: 0, body: '', error: `tried ${Math.min(candidates.length, 40)} free ${cc} proxies, none returned a usable response` };
}
