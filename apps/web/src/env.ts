import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env loader (no dependency). Imported first in server.ts so process.env is populated
 * before the app reads ANTHROPIC_API_KEY. Put `ANTHROPIC_API_KEY=sk-ant-...` in apps/web/.env
 * (gitignored) to switch the app from stubs to live Claude. Real environment vars win.
 */
const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
