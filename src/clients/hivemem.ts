// HiveMem holds project knowledge: one workspace per project, with each reference file synced
// as a revision-aware source (POST /v1/knowledge/sources/sync). ArdentStudio calls it with its
// own Oathweave service identity (audience `hivemem`), linked in HiveMem's
// HIVEMEM_OATHWEAVE_SERVICES_JSON with the memories:write and workspaces:write scopes.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ServiceTokenProvider } from './service-token.js';

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
}

export class HiveMemClient {
  private readonly request: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HiveMemClientOptions) {
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Unauthenticated liveness of the HiveMem service. */
  async health(): Promise<{ status: string }> {
    const response = await this.request(`${this.baseUrl}/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new HiveMemError(`HiveMem health answered HTTP ${response.status}`, response.status);
    return z.object({ status: z.string() }).loose().parse(await response.json());
  }

  /** Create the project workspace. HiveMem returns the existing workspace when it already exists. */
  async ensureWorkspace(input: { workspace_id: string; title: string; description?: string; metadata?: Record<string, string> }) {
    return workspaceSchema.parse(await this.call('POST', '/v1/workspaces', {
      workspace_id: input.workspace_id, title: input.title.slice(0, 200), description: input.description ?? null, metadata: input.metadata ?? {},
    }));
  }

  async syncKnowledgeSource(body: KnowledgeSyncRequest): Promise<KnowledgeSyncResponse> {
    if (body.chunks.length > HIVEMEM_MAX_CHUNKS) throw new HiveMemError(`A source sync holds at most ${HIVEMEM_MAX_CHUNKS} chunks`, 400);
    return knowledgeSyncResponseSchema.parse(await this.call('POST', '/v1/knowledge/sources/sync', body));
  }

  /** Validate, then write: a preview proves the request before anything changes. */
  async syncKnowledgeSourceChecked(body: Omit<KnowledgeSyncRequest, 'mode'>): Promise<{ preview: KnowledgeSyncResponse; applied: KnowledgeSyncResponse }> {
    const preview = await this.syncKnowledgeSource({ ...body, mode: 'preview' });
    const applied = await this.syncKnowledgeSource({ ...body, mode: 'apply' });
    return { preview, applied };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const attempt = async () => this.request(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.options.tokens.token()}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    let response = await attempt();
    if (response.status === 401) {
      await response.body?.cancel();
      this.options.tokens.invalidate();
      response = await attempt();
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { detail?: unknown; error?: unknown } | null;
      const message = typeof detail?.detail === 'string' ? detail.detail : typeof detail?.error === 'string' ? detail.error : `HiveMem answered HTTP ${response.status}`;
      throw new HiveMemError(message.slice(0, 300), response.status);
    }
    return response.status === 204 ? null : response.json();
  }
}
