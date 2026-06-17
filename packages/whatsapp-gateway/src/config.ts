export type RuntimeMode = 'echo' | 'librechat';

export interface GatewayConfig {
  graphVersion: string;
  verifyToken: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  port: number;
  /** Phase 2 = echo; Phase 3 = librechat (drive a LibreChat agent). */
  runtimeMode: RuntimeMode;
  /** PII salt for hashing inbound sender numbers. */
  senderHashSalt: string;
  /** Cost/abuse circuit-breaker. */
  breaker: { perSenderPerMinute: number; maxInboundChars: number; tenantDailyTokenBudget: number };
  /** Present only in `librechat` mode (validated below). */
  libreChat?: { baseUrl: string; agentApiKey: string; agentId: string; tenantId: string };
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
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')}`);

  const runtimeMode: RuntimeMode = env.WHASER_RUNTIME === 'librechat' ? 'librechat' : 'echo';

  let libreChat: GatewayConfig['libreChat'];
  if (runtimeMode === 'librechat') {
    const need = ['LIBRECHAT_BASE_URL', 'LIBRECHAT_AGENT_API_KEY', 'WHASER_AGENT_ID', 'WHASER_TENANT_ID'];
    const missingLc = need.filter((k) => !env[k]);
    if (missingLc.length) throw new Error(`Missing env for librechat runtime: ${missingLc.join(', ')}`);
    libreChat = {
      baseUrl: env.LIBRECHAT_BASE_URL!,
      agentApiKey: env.LIBRECHAT_AGENT_API_KEY!,
      agentId: env.WHASER_AGENT_ID!,
      tenantId: env.WHASER_TENANT_ID!,
    };
  }

  return {
    graphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
    appSecret: env.WHATSAPP_APP_SECRET!,
    accessToken: env.WHATSAPP_ACCESS_TOKEN!,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
    port: Number(env.GATEWAY_PORT ?? 3091),
    runtimeMode,
    senderHashSalt: env.WHASER_SENDER_HASH_SALT ?? 'dev-salt-change-me',
    breaker: {
      perSenderPerMinute: Number(env.WHASER_RATE_LIMIT_PER_MIN ?? 20),
      maxInboundChars: Number(env.WHASER_MAX_INBOUND_CHARS ?? 4000),
      tenantDailyTokenBudget: Number(env.WHASER_TENANT_DAILY_TOKEN_BUDGET ?? 2_000_000),
    },
    libreChat,
  };
}
