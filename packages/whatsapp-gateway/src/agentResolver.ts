export interface AgentRoute {
  agentId: string;
  tenantId: string;
}

/** Resolves an inbound business number to the agent (and tenant) that should answer it. */
export interface AgentResolver {
  resolve(phoneNumberId: string): Promise<AgentRoute | null>;
}

/**
 * In-memory resolver for dev/test. Production reads the `waNumbers` collection
 * (one number per agent; see docs/ARCHITECTURE.md).
 */
export class InMemoryAgentResolver implements AgentResolver {
  private readonly map = new Map<string, AgentRoute>();

  constructor(initial?: Record<string, AgentRoute>) {
    if (initial) {
      for (const [phoneNumberId, route] of Object.entries(initial)) {
        this.map.set(phoneNumberId, route);
      }
    }
  }

  bind(phoneNumberId: string, route: AgentRoute): void {
    this.map.set(phoneNumberId, route);
  }

  async resolve(phoneNumberId: string): Promise<AgentRoute | null> {
    return this.map.get(phoneNumberId) ?? null;
  }
}
