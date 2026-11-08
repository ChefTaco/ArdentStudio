// ArdentStudio's own service identity: short-lived Oathweave client_credentials tokens,
// one machine client per audience (Oathweave binds a client to one audience). A token is
// fetched on first use and replaced before it expires; nothing has to renew it by hand.
import { z } from 'zod';

export interface ServiceTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ServiceTokenError extends Error {
  override name = 'ServiceTokenError';
}

const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().optional(), token_type: z.string().optional() });

const MIN_LIFETIME_MS = 10_000;
const MAX_LIFETIME_MS = 3600_000;
const FAILURE_BACKOFF_MS = 5_000;

function unverifiedExpiry(token: string): number | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && 'exp' in claims && typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class ServiceTokenProvider {
  private cached: { token: string; refreshAt: number; expiresAt: number } | undefined;
  private inFlight: Promise<string> | undefined;
  private retryAfter = 0;
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ServiceTokenOptions) {
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async token(): Promise<string> {
    const at = this.now();
    const usable = this.cached && this.cached.expiresAt - 5_000 > at ? this.cached : undefined;
    if (usable && usable.refreshAt > at) return usable.token;
    if (this.inFlight) return usable ? usable.token : this.inFlight;
    if (at < this.retryAfter) {
      if (usable) return usable.token;
      throw new ServiceTokenError('Oathweave token request is backing off after a failure');
    }
    const refresh = this.fetchToken().finally(() => { this.inFlight = undefined; });
    this.inFlight = refresh;
    if (usable) {
      refresh.catch(() => undefined);
      return usable.token;
    }
    return refresh;
  }

  /** Forget the cached token, for example after the resource answered 401. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const startedAt = this.now();
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.options.clientId, client_secret: this.options.clientSecret });
    if (this.options.scope) form.set('scope', this.options.scope);
    try {
      const response = await this.request(this.options.tokenUrl, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      // Never include the response body: it may echo the request.
      if (!response.ok) throw new ServiceTokenError(`Oathweave token request failed (HTTP ${response.status})`);
      const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ServiceTokenError('Oathweave token response is malformed');
      const lifetime = Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, (parsed.data.expires_in ?? 300) * 1000));
      const expiresAt = Math.min(startedAt + lifetime, unverifiedExpiry(parsed.data.access_token) ?? Number.POSITIVE_INFINITY);
      if (expiresAt - 5_000 <= this.now()) throw new ServiceTokenError('Oathweave issued an expired token');
      const span = expiresAt - startedAt;
      this.cached = { token: parsed.data.access_token, expiresAt, refreshAt: startedAt + Math.max(0, Math.min(span * 0.8, span - 30_000)) };
      this.retryAfter = 0;
      return parsed.data.access_token;
    } catch (error) {
      this.retryAfter = this.now() + FAILURE_BACKOFF_MS;
      throw error instanceof ServiceTokenError ? error : new ServiceTokenError(`Oathweave token request failed (${error instanceof Error ? error.name : 'error'})`);
    }
  }
}
