// Room records: layouts, conversations, messages, decisions and derived activity.
// Their routes arrive with the conversation room; the schema and storage rules are fixed now.
import { newId } from '../../ids.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export interface RoomLayout {
  project_id: string; revision: number; seats: unknown[]; placements: unknown[]; zone_labels: Record<string, string>;
  created_by: string; created_at: string;
}
export type ConversationKind = 'team' | 'direct' | 'discussion';
export interface Discussion { question: string; desired_output: 'decision' | 'short_doc' | 'options'; participants: string[]; max_rounds: number; round: number; state: 'open' | 'running' | 'stopped' | 'done' }
export interface Conversation {
  id: string; project_id: string; kind: ConversationKind; parent_id: string | null; title: string; discussion: Discussion | null;
  last_message_seq: number; created_by: string; created_at: string; updated_at: string; stopped_at: string | null;
}
export type MessageAuthor = { kind: 'user'; user_id: string } | { kind: 'agent'; binding_id: string; role_key: string | null } | { kind: 'system' };
export type MessageState = 'streaming' | 'complete' | 'failed';
export interface Message {
  id: string; project_id: string; conversation_id: string; seq: number; author: MessageAuthor; addressees: string[];
  reply_to: string | null; thread_root: string | null; kind: string; body_md: string; attachments: string[]; links: Record<string, unknown>;
  ardent: { task_id: string; session_id: string | null } | null; state: MessageState; created_at: string; updated_at: string;
}
export interface Decision {
  id: string; project_id: string; title: string; statement_md: string; rationale_md: string; sources: Array<{ kind: string; ref: string }>;
  decided_by: string; superseded_by: string | null; created_at: string;
}
export interface Activity { project_id: string; binding_id: string; state: string; label: string; source: Record<string, unknown>; since: string }

interface ConversationRow { id: string; project_id: string; kind: ConversationKind; parent_id: string | null; title: string; discussion_json: string | null; last_message_seq: number; created_by: string; created_at: string; updated_at: string; stopped_at: string | null }
interface MessageRow { id: string; project_id: string; conversation_id: string; seq: number; author_json: string; addressees_json: string; reply_to: string | null; thread_root: string | null; kind: string; body_md: string; attachments_json: string; links_json: string; ardent_task_id: string | null; ardent_session_id: string | null; state: MessageState; created_at: string; updated_at: string }

const toConversation = (row: ConversationRow): Conversation => ({ ...row, discussion: readJson<Discussion | null>(row.discussion_json, null) });
const toMessage = (row: MessageRow): Message => ({
  id: row.id, project_id: row.project_id, conversation_id: row.conversation_id, seq: row.seq, author: readJson<MessageAuthor>(row.author_json, { kind: 'system' }),
  addressees: readJson(row.addressees_json, []), reply_to: row.reply_to, thread_root: row.thread_root, kind: row.kind, body_md: row.body_md,
  attachments: readJson(row.attachments_json, []), links: readJson(row.links_json, {}),
  ardent: row.ardent_task_id ? { task_id: row.ardent_task_id, session_id: row.ardent_session_id } : null, state: row.state,
  created_at: row.created_at, updated_at: row.updated_at,
});

export class RoomRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  saveLayout(projectId: string, input: { seats: unknown[]; placements: unknown[]; zone_labels: Record<string, string>; createdBy: string }): RoomLayout {
    const revision = ((this.db.prepare('SELECT MAX(revision) AS n FROM room_layouts WHERE project_id = ?').get(projectId) as { n: number | null }).n ?? 0) + 1;
    this.db.prepare('INSERT INTO room_layouts (project_id, revision, seats_json, placements_json, zone_labels_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, revision, writeJson(input.seats), writeJson(input.placements), writeJson(input.zone_labels), input.createdBy, this.clock.now().toISOString());
    return this.layout(projectId)!;
  }

  layout(projectId: string): RoomLayout | undefined {
    const row = this.db.prepare('SELECT * FROM room_layouts WHERE project_id = ? ORDER BY revision DESC LIMIT 1').get(projectId) as
      { project_id: string; revision: number; seats_json: string; placements_json: string; zone_labels_json: string; created_by: string; created_at: string } | undefined;
    return row ? { project_id: row.project_id, revision: row.revision, seats: readJson(row.seats_json, []), placements: readJson(row.placements_json, []),
      zone_labels: readJson(row.zone_labels_json, {}), created_by: row.created_by, created_at: row.created_at } : undefined;
  }

  createConversation(input: { projectId: string; kind: ConversationKind; parentId?: string | null; title: string; discussion?: Discussion | null; createdBy: string }): Conversation {
    const id = newId('conversation');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO conversations (id, project_id, kind, parent_id, title, discussion_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.kind, input.parentId ?? null, input.title,
      input.discussion ? writeJson(input.discussion) : null, input.createdBy, now, now);
    return this.conversation(id)!;
  }

  conversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : undefined;
  }

  conversations(projectId: string): Conversation[] {
    return (this.db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at, id').all(projectId) as ConversationRow[]).map(toConversation);
  }

  /** Append a message; its seq is per conversation and assigned in this transaction. */
  addMessage(input: { conversationId: string; author: MessageAuthor; addressees?: string[]; replyTo?: string | null; threadRoot?: string | null; kind: string;
    bodyMd: string; attachments?: string[]; links?: Record<string, unknown>; ardent?: { task_id: string; session_id: string | null } | null; state: MessageState }): Message {
    return this.db.transaction(() => {
      const conversation = this.conversation(input.conversationId);
      if (!conversation) throw new Error('Conversation not found');
      const { last_message_seq: seq } = this.db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1, updated_at = ? WHERE id = ? RETURNING last_message_seq')
        .get(this.clock.now().toISOString(), input.conversationId) as { last_message_seq: number };
      const id = newId('message');
      const now = this.clock.now().toISOString();
      this.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, seq, author_json, addressees_json, reply_to, thread_root, kind, body_md,
        attachments_json, links_json, ardent_task_id, ardent_session_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, conversation.project_id, conversation.id, seq, writeJson(input.author), writeJson(input.addressees ?? []), input.replyTo ?? null,
          input.threadRoot ?? null, input.kind, input.bodyMd, writeJson(input.attachments ?? []), writeJson(input.links ?? {}),
          input.ardent?.task_id ?? null, input.ardent?.session_id ?? null, input.state, now, now);
      return this.message(id)!;
    })();
  }

  /** Complete or fail a message. The final stored text is authoritative over any live deltas. */
  finishMessage(id: string, update: { bodyMd: string; state: Exclude<MessageState, 'streaming'> }): Message {
    this.db.prepare('UPDATE messages SET body_md = ?, state = ?, updated_at = ? WHERE id = ?').run(update.bodyMd, update.state, this.clock.now().toISOString(), id);
    return this.message(id)!;
  }

  message(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  messageForArdentTask(taskId: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE ardent_task_id = ?').get(taskId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  messages(conversationId: string, after = 0, limit = 200): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(conversationId, after, limit) as MessageRow[]).map(toMessage);
  }

  createDecision(input: { projectId: string; title: string; statementMd: string; rationaleMd?: string; sources?: Decision['sources']; decidedBy: string }): Decision {
    const id = newId('decision');
    this.db.prepare(`INSERT INTO decisions (id, project_id, title, statement_md, rationale_md, source_json, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.title, input.statementMd, input.rationaleMd ?? '', writeJson(input.sources ?? []), input.decidedBy, this.clock.now().toISOString());
    return this.decision(id)!;
  }

  supersedeDecision(id: string, by: string): Decision {
    this.db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(by, id);
    return this.decision(id)!;
  }

  decision(id: string): Decision | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as (Omit<Decision, 'sources'> & { source_json: string }) | undefined;
    if (!row) return undefined;
    const { source_json, ...rest } = row;
    return { ...rest, sources: readJson(source_json, []) };
  }

  decisions(projectId: string): Decision[] {
    return (this.db.prepare('SELECT id FROM decisions WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Array<{ id: string }>).map(row => this.decision(row.id)!);
  }

  /** Activity is derived from real task and journal records only; the conductor writes it. */
  setActivity(activity: Activity): void {
    this.db.prepare(`INSERT INTO activity (project_id, binding_id, state, label, source_json, since) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, binding_id) DO UPDATE SET state = excluded.state, label = excluded.label, source_json = excluded.source_json, since = excluded.since`)
      .run(activity.project_id, activity.binding_id, activity.state, activity.label, writeJson(activity.source), activity.since);
  }

  activity(projectId: string): Activity[] {
    return (this.db.prepare('SELECT * FROM activity WHERE project_id = ? ORDER BY binding_id').all(projectId) as Array<Omit<Activity, 'source'> & { source_json: string }>)
      .map(({ source_json, ...rest }) => ({ ...rest, source: readJson(source_json, {}) }));
  }
}
