import express, { type Router } from 'express';
import type { JobStore } from './types';
import { verifyChallenge, handleInbound } from './webhook';

export interface WebhookRouterOptions {
  verifyToken: string;
  appSecret: string;
  store: JobStore;
}

/**
 * Express router for the Cloud API webhook. Mount at /api/whatsapp/webhook.
 * GET = verify-token challenge; POST = HMAC-verified inbound (raw body required for HMAC).
 */
export function createWebhookRouter(opts: WebhookRouterOptions): Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    const challenge = verifyChallenge(req.query as Record<string, unknown>, opts.verifyToken);
    if (challenge == null) {
      res.sendStatus(403);
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  });

  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const result = await handleInbound({
      rawBody: req.body as Buffer,
      signature: req.header('x-hub-signature-256'),
      appSecret: opts.appSecret,
      store: opts.store,
    });
    res.sendStatus(result.status);
  });

  return router;
}
