import express from 'express';
import { loadConfig } from './config';
import { InMemoryJobStore } from './inboundQueue';
import { CloudApiClient } from './cloudApiClient';
import { InboundWorker, echoHandler } from './worker';
import { createWebhookRouter } from './express';
import type { InboundHandler } from './types';
import { LibreChatAgentClient } from './agentRuntime';
import { InMemoryAgentResolver } from './agentResolver';
import { InMemoryConversationStore } from './conversationStore';
import { CircuitBreaker } from './circuitBreaker';
import { createAgentReplyHandler } from './agentReplyHandler';

/**
 * Standalone Whaser WhatsApp gateway for local smoke-testing before it is wired into LibreChat.
 *
 *   WHASER_RUNTIME=echo       (default) — reply with the same text (Phase 2)
 *   WHASER_RUNTIME=librechat            — drive a LibreChat agent via the Agents API (Phase 3)
 *
 * Uses the in-memory stores; production swaps in the MongoDB-backed JobStore / resolver /
 * conversation store and the LibreChat-runtime handler.
 */
function buildHandler(config: ReturnType<typeof loadConfig>): InboundHandler {
  if (config.runtimeMode !== 'librechat' || !config.libreChat) return echoHandler;

  const { baseUrl, agentApiKey, agentId, tenantId } = config.libreChat;
  const resolver = new InMemoryAgentResolver({ [config.phoneNumberId]: { agentId, tenantId } });
  const runtime = new LibreChatAgentClient({ baseUrl, apiKey: agentApiKey });
  const conversations = new InMemoryConversationStore();
  const breaker = new CircuitBreaker(config.breaker);
  return createAgentReplyHandler({
    resolver,
    runtime,
    conversations,
    breaker,
    hashSalt: config.senderHashSalt,
    onBlocked: (reason, msg) => console.warn('[breaker] blocked', msg.waMessageId, reason),
  });
}

function main(): void {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const gateway = new CloudApiClient({ accessToken: config.accessToken, graphVersion: config.graphVersion });
  const worker = new InboundWorker({
    store,
    gateway,
    handler: buildHandler(config),
    onError: (err, msg) => console.error('[worker] error handling', msg?.waMessageId, err),
  });

  const app = express();
  app.get('/healthz', (_req, res) => res.json({ ok: true, runtime: config.runtimeMode }));
  app.use(
    '/api/whatsapp/webhook',
    createWebhookRouter({ verifyToken: config.verifyToken, appSecret: config.appSecret, store }),
  );

  worker.start();
  app.listen(config.port, () => {
    console.log(`Whaser WhatsApp gateway (${config.runtimeMode}) listening on :${config.port}`);
  });
}

main();
