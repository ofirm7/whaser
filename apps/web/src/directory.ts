/**
 * Stand-in for the LDAP directory (lldap in production). Seeds two tenants and a few users so
 * REQ 4 (LDAP-like multi-tenant users) and REQ 5 (tenant-scoped agents) are demonstrable.
 */
export interface Tenant {
  id: string;
  name: string;
}

export interface DirectoryUser {
  username: string;
  password: string;
  displayName: string;
  tenantId: string;
  role: 'admin' | 'user';
}

export const TENANTS: Tenant[] = [
  { id: 'acme', name: 'Acme Inc.' },
  { id: 'globex', name: 'Globex Corp.' },
];

export const USERS: DirectoryUser[] = [
  { username: 'alice', password: 'password', displayName: 'Alice', tenantId: 'acme', role: 'admin' },
  { username: 'bob', password: 'password', displayName: 'Bob', tenantId: 'acme', role: 'user' },
  { username: 'carol', password: 'password', displayName: 'Carol', tenantId: 'globex', role: 'admin' },
];

export function authenticate(username: string, password: string): DirectoryUser | null {
  const u = USERS.find((x) => x.username === username && x.password === password);
  return u ?? null;
}

export function tenantName(id: string): string {
  return TENANTS.find((t) => t.id === id)?.name ?? id;
}
