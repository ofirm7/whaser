import express from 'express';
import { loadConfig } from './config';
import { InMemoryJobStore } from './inboundQueue';
import { CloudApiClient } from './cloudApiClient';
import { InboundWorker, echoHandler } from './worker';
import { createWebhookRouter } from './express';

/**
 * Phase-2 standalone echo gateway, for local smoke-testing the WhatsApp round-trip before it
 * is wired into LibreChat (Phase 3). Uses the in-memory queue; production swaps in the
 * MongoDB-backed store and the LibreChat-runtime handler.
 */
function main(): void {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const gateway = new CloudApiClient({
    accessToken: config.accessToken,
    graphVersion: config.graphVersion,
  });
  const worker = new InboundWorker({
    store,
    gateway,
    handler: echoHandler,
    onError: (err, msg) => console.error('[worker] error handling', msg?.waMessageId, err),
  });

  const app = express();
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(
    '/api/whatsapp/webhook',
    createWebhookRouter({ verifyToken: config.verifyToken, appSecret: config.appSecret, store }),
  );

  worker.start();
  app.listen(config.port, () => {
    console.log(`Whaser WhatsApp gateway (echo) listening on :${config.port}`);
  });
}

main();
