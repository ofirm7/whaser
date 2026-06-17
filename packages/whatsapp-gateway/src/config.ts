export interface GatewayConfig {
  graphVersion: string;
  verifyToken: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  port: number;
}

/** Load + validate gateway config from the environment (see deploy/.env.example). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = [
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
  return {
    graphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
    appSecret: env.WHATSAPP_APP_SECRET!,
    accessToken: env.WHATSAPP_ACCESS_TOKEN!,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
    port: Number(env.GATEWAY_PORT ?? 3091),
  };
}
