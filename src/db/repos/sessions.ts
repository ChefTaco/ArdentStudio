// The Ardent session each role uses in a conversation. Ardent sessions are execution context
// only: the transcript stays in `messages`. `last_seen_seq` remembers which project messages
// the agent was already shown, so the next turn sends only what is new.
import type { Db } from '../database.js';
import type { Clock } from '../json.js';

export type SessionContext = 'direct' | 'mission';

export interface AgentSession {
  conversation_id: string; role_key: string; agent_ref: string; context: SessionContext; project_id: string;
  session_key: string; session_id: string; turns: number; last_seen_seq: number; created_at: string; updated_at: string;
}

/** The Ardent session key for a project conversation and role. */
export function sessionKey(projectId: string, conversationId: string, roleKey: string): string {
  return `studio:${projectId}:${conversationId}:${roleKey}`;
}

export class SessionRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  get(conversationId: string, roleKey: string, agentRef: string, context: SessionContext): AgentSession | undefined {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? AND role_key = ? AND agent_ref = ? AND context = ?')
      .get(conversationId, roleKey, agentRef, context) as AgentSession | undefined;
  }

  /** Remember the session Ardent opened for this key. Re-opening the same key returns the same session. */
  save(input: { conversationId: string; roleKey: string; agentRef: string; context: SessionContext; projectId: string; sessionKey: string; sessionId: string }): AgentSession {
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO agent_sessions (conversation_id, role_key, agent_ref, context, project_id, session_key, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_id, role_key, agent_ref, context) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`)
      .run(input.conversationId, input.roleKey, input.agentRef, input.context, input.projectId, input.sessionKey, input.sessionId, now, now);
    return this.get(input.conversationId, input.roleKey, input.agentRef, input.context)!;
  }

  /** A turn was accepted: count it and move the seen cursor forward (never back). */
  recordTurn(session: Pick<AgentSession, 'conversation_id' | 'role_key' | 'agent_ref' | 'context'>, seenSeq: number): void {
    this.db.prepare(`UPDATE agent_sessions SET turns = turns + 1, last_seen_seq = MAX(last_seen_seq, ?), updated_at = ?
      WHERE conversation_id = ? AND role_key = ? AND agent_ref = ? AND context = ?`)
      .run(seenSeq, this.clock.now().toISOString(), session.conversation_id, session.role_key, session.agent_ref, session.context);
  }
}
