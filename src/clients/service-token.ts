// ArdentStudio's own service identity: short-lived Oathweave client_credentials tokens,
// one machine client per audience (Oathweave binds a client to one audience). A token is
// fetched on first use and replaced before it expires; nothing has to renew it by hand.
// The cache, refresh, backoff and bounded response reading are the suite's shared provider
// (@hivemagnus/hive-common/oathweave); this class keeps Studio's published constructor.
import {
  createServiceTokenProvider,
  isServiceTokenError,
  ServiceTokenError,
  type ServiceTokenProvider as ServiceTokenSource,
} from '@hivemagnus/hive-common/oathweave';

export { isServiceTokenError, ServiceTokenError, type ServiceTokenSource };

export interface ServiceTokenOptions {
  /** The Oathweave token endpoint. https only. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Allow an `http:` token URL on a loopback host. For tests only. */
  allowInsecureLoopback?: boolean;
}

export class ServiceTokenProvider implements ServiceTokenSource {
  private readonly provider: ServiceTokenSource;

  /** Throws a TypeError for a token URL that is not https or holds credentials. */
  constructor(options: ServiceTokenOptions) {
    this.provider = createServiceTokenProvider({
      tokenUrl: options.tokenUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scope: options.scope,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    });
  }

  /** A usable access token: the cached one, or a new one. Rejects with a ServiceTokenError. */
  token(): Promise<string> {
    return this.provider.token();
  }

  /** Forget the cached token, for example after the resource answered 401. */
  invalidate(): void {
    this.provider.invalidate();
  }
}
