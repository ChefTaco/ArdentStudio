// Wires configuration, storage, clients and workers into one running service.
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { AgentDirectory } from './agents/directory.js';
import { createAuthenticator, createOathweaveVerifier, type Authenticator } from './auth/oathweave.js';
import { BlobStore } from './blobs/store.js';
import { ChatterMostClient } from './clients/chattermost.js';
import { HiveMemClient } from './clients/hivemem.js';
import { MagnusClient } from './clients/magnus.js';
import { ServiceTokenProvider } from './clients/service-token.js';
import type { Config } from './config.js';
import { openDatabase } from './db/database.js';
import { systemClock, type Clock } from './db/json.js';
import { Store } from './db/store.js';
import { EventBus } from './events/bus.js';
import { KnowledgeSync } from './knowledge/sync.js';
import { createLogger, type Logger } from './logger.js';
import { createApp } from './server/app.js';
import { loadSeedTemplates } from './templates/seeds.js';

export const DATABASE_FILE = 'studio.sqlite';

export interface Service {
  app: ReturnType<typeof createApp>;
  store: Store;
  magnus: MagnusClient;
  hivemem: HiveMemClient;
  chattermost: ChatterMostClient | undefined;
  knowledge: KnowledgeSync;
  /** Start background work (knowledge sync, event compaction). */
  start(): void;
  stop(): Promise<void>;
}

export function createService(config: Config, options: { logger?: Logger; clock?: Clock; authenticate?: Authenticator; fetch?: typeof fetch } = {}): Service {
  const logger = options.logger ?? createLogger(config.logLevel);
  const clock = options.clock ?? systemClock;
  const db = openDatabase(join(config.dataDir, DATABASE_FILE));
  const bus = new EventBus();
  const store = new Store(db, clock, bus);
  const blobs = new BlobStore(db, config.dataDir, config.maxBlobBytes, clock);
  const recovered = blobs.recoverPartialWrites();
  if (recovered) logger.warn('Removed incomplete blob writes', { count: recovered });
  const seeded = loadSeedTemplates(store);
  if (seeded) logger.info('Loaded seed templates', { count: seeded });

  const tokens = (client: Config['magnus']) => new ServiceTokenProvider({
    tokenUrl: config.oathweave.tokenUrl, clientId: client.clientId, clientSecret: client.clientSecret, scope: client.scope,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const magnus = new MagnusClient({ baseUrl: config.magnus.url, tokens: tokens(config.magnus), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const hivemem = new HiveMemClient({ baseUrl: config.hivemem.url, tokens: tokens(config.hivemem), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const chattermost = config.chattermost ? new ChatterMostClient(config.chattermost.webhookUrl, options.fetch) : undefined;
  const knowledge = new KnowledgeSync(store, blobs, hivemem, logger);
  const agents = new AgentDirectory(magnus, store);
  const authenticate = options.authenticate ?? createAuthenticator(
    createOathweaveVerifier({ issuer: config.oathweave.issuer, jwksUrl: config.oathweave.jwksUrl, userinfoUrl: config.oathweave.userinfoUrl }),
    config.oathweave.identities,
  );
  const app = createApp({ store, blobs, bus, authenticate, agents, hivemem, knowledge, logger });

  let maintenance: NodeJS.Timeout | undefined;
  const maintain = () => {
    try {
      const cutoff = new Date(clock.now().getTime() - config.eventRetentionDays * 86_400_000);
      const removed = store.events.compact(cutoff);
      const keys = store.idempotency.prune();
      if (removed || keys) logger.info('Compacted project events', { events: removed, idempotency_keys: keys });
    } catch (error) {
      logger.error('Maintenance failed', { error: error instanceof Error ? error.message : 'unknown' });
    }
  };

  return {
    app, store, magnus, hivemem, chattermost, knowledge,
    start() {
      knowledge.start();
      maintain();
      maintenance = setInterval(maintain, 3600_000);
      maintenance.unref();
    },
    async stop() {
      if (maintenance) clearInterval(maintenance);
      await knowledge.stop();
      db.close();
    },
  };
}

export function listen(service: Service, config: Config, logger: Logger): ServerType {
  return serve({ fetch: service.app.fetch, hostname: config.host, port: config.port }, info => {
    logger.info('ArdentStudio listening', { host: config.host, port: info.port });
  });
}
