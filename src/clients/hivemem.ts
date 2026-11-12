// HiveMem holds project knowledge: one workspace per project, with each reference file synced
// as a revision-aware source (POST /v1/knowledge/sources/sync). ArdentStudio calls it with its
// own Oathweave service identity (audience `hivemem`), linked in HiveMem's
// HIVEMEM_OATHWEAVE_SERVICES_JSON with the memories:write and workspaces:write scopes.
// The HTTP layer is @hivemagnus/hivemem-sdk; this module keeps Studio's own interface on top of it.
import { createHash } from 'node:crypto';
import { outboundHeaders } from '@hivemagnus/hive-common/context';
import { HiveMem, HiveMemHTTPError } from '@hivemagnus/hivemem-sdk';
import { z } from 'zod';
import type { ServiceTokenProvider } from './service-token.js';
import { trimTrailingSlashes } from '../url.js';

export class HiveMemError extends Error {
  override name = 'HiveMemError';
  constructor(message: string, readonly status: number) { super(message); }
}

export interface KnowledgeChunk {
  chunk_key: string;
  content: string;
  content_hash: string;
  heading?: string | null;
  tags?: string[];
}

export interface KnowledgeSyncRequest {
  mode: 'preview' | 'apply';
  workspace_id: string;
  project_id: string;
  source_id: string;
  source_uri: string;
  revision: string;
  observed_at: string;
  expires_at?: string | null;
  chunks: KnowledgeChunk[];
}

export const knowledgeSyncResponseSchema = z.object({
  mode: z.enum(['preview', 'apply']),
  workspace_id: z.string(),
  project_id: z.string(),
  source_id: z.string(),
  revision: z.string(),
  created: z.number().int(),
  superseded: z.number().int(),
  retired: z.number().int(),
  unchanged: z.number().int(),
}).loose();
export type KnowledgeSyncResponse = z.infer<typeof knowledgeSyncResponseSchema>;

export const workspaceSchema = z.object({ workspace_id: z.string(), owner_agent_id: z.string(), deleted_at: z.string().nullable().optional() }).loose();

/** HiveMem limits one source sync to 500 chunks, 64 KiB per chunk and 4 MiB in total. */
export const HIVEMEM_MAX_CHUNKS = 500;
export const HIVEMEM_MAX_CHUNK_BYTES = 65_536;
export const HIVEMEM_MAX_SYNC_BYTES = 4 * 1024 * 1024;

export function chunkHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface HiveMemClientOptions {
  baseUrl: string;
  tokens: Pick<ServiceTokenProvider, 'token' | 'invalidate'>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra headers per request; defaults to the current request context (x-request-id, traceparent). */
  headers?: () => Record<string, string>;
}

/** Studio's errors: the server's `detail` (or `error`), else the HTTP status. */
function translate(error: unknown): unknown {
  if (!(error instanceof HiveMemHTTPError)) return error;
  const details = error.details as { detail?: unknown; error?: unknown } | null | undefined;
  const message = typeof details?.detail === 'string' ? details.detail : typeof details?.error === 'string' ? details.error : `HiveMem answered HTTP ${error.statusCode}`;
  return new HiveMemError(message.slice(0, 300), error.statusCode);
}

async function sdkCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw translate(error);
  }
}

/**
 * The SDK reads an error body as JSON and then as text, which fails on a non-JSON body (a proxy
 * page, for example). Hand it an empty JSON body instead so the error still carries its status.
 */
function jsonErrorBodies(request: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await request(input, init);
    if (response.ok || response.headers.get('content-type')?.includes('json')) return response;
    await response.body?.cancel().catch(() => undefined);
    return new Response('null', { status: response.status, statusText: response.statusText, headers: { 'content-type': 'application/json' } });
  };
}

export class HiveMemClient {
  private readonly sdk: HiveMem;
  private readonly probe: HiveMem;

  constructor(options: HiveMemClientOptions) {
    const request = options.fetch ?? ((input, init) => fetch(input, init));
    const fetchImpl = jsonErrorBodies(request);
    const headers = options.headers ?? (() => outboundHeaders());
    this.sdk = new HiveMem({
      baseUrl: trimTrailingSlashes(options.baseUrl),
      fetchImpl,
      headers,
      // Studio keeps its own retry schedule for knowledge sync; the SDK only retries once after a 401.
      maxRetries: 0,
      timeoutMs: options.timeoutMs ?? 30_000,
      tokenProvider: async ({ forceRefresh }) => {
        if (forceRefresh) options.tokens.invalidate();
        return options.tokens.token();
      },
    });
    // Health is unauthenticated: an empty token keeps the SDK from reading one from the environment.
    this.probe = new HiveMem({ baseUrl: this.sdk.baseUrl, fetchImpl, headers, token: '', maxRetries: 0, timeoutMs: 5_000 });
  }

  /** Unauthenticated liveness of the HiveMem service. */
  async health(): Promise<{ status: string }> {
    return z.object({ status: z.string() }).loose().parse(await sdkCall(() => this.probe.health()));
  }

  /** Create the project workspace. HiveMem returns the existing workspace when it already exists. */
  async ensureWorkspace(input: { workspace_id: string; title: string; description?: string; metadata?: Record<string, string> }) {
    return workspaceSchema.parse(await sdkCall(() => this.sdk.createWorkspace(input.workspace_id, {
      title: input.title.slice(0, 200), description: input.description ?? null, metadata: input.metadata ?? {},
    })));
  }

  async syncKnowledgeSource(body: KnowledgeSyncRequest): Promise<KnowledgeSyncResponse> {
    if (body.chunks.length > HIVEMEM_MAX_CHUNKS) throw new HiveMemError(`A source sync holds at most ${HIVEMEM_MAX_CHUNKS} chunks`, 400);
    return knowledgeSyncResponseSchema.parse(await sdkCall(() => this.sdk.syncKnowledgeSource({ ...body })));
  }

  /** Validate, then write: a preview proves the request before anything changes. */
  async syncKnowledgeSourceChecked(body: Omit<KnowledgeSyncRequest, 'mode'>): Promise<{ preview: KnowledgeSyncResponse; applied: KnowledgeSyncResponse }> {
    const preview = await this.syncKnowledgeSource({ ...body, mode: 'preview' });
    const applied = await this.syncKnowledgeSource({ ...body, mode: 'apply' });
    return { preview, applied };
  }
}
