import type { Db } from './database.js';
import type { Clock } from './json.js';
import { AgentRepository } from './repos/agents.js';
import { AuditRepository, type AuditActor } from './repos/audit.js';
import { EventRepository, type ProjectEventRecord } from './repos/events.js';
import { FileRepository } from './repos/files.js';
import { IdempotencyRepository } from './repos/idempotency.js';
import { ProjectRepository } from './repos/projects.js';
import { ReviewRepository } from './repos/review.js';
import { RoomRepository } from './repos/room.js';
import { TaskRepository } from './repos/tasks.js';
import { TeamRepository } from './repos/team.js';
import { TemplateRepository } from './repos/templates.js';
import type { EventBus } from '../events/bus.js';
import type { ProjectEventType } from '../events/types.js';

/** Every repository over one database, with transactions that publish events after commit. */
export class Store {
  readonly projects: ProjectRepository;
  readonly files: FileRepository;
  readonly templates: TemplateRepository;
  readonly team: TeamRepository;
  readonly room: RoomRepository;
  readonly tasks: TaskRepository;
  readonly review: ReviewRepository;
  readonly agents: AgentRepository;
  readonly events: EventRepository;
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;
  private pending: ProjectEventRecord[] = [];
  private depth = 0;

  constructor(readonly db: Db, readonly clock: Clock, private readonly bus: EventBus) {
    this.projects = new ProjectRepository(db, clock);
    this.files = new FileRepository(db, clock);
    this.templates = new TemplateRepository(db, clock);
    this.team = new TeamRepository(db, clock);
    this.room = new RoomRepository(db, clock);
    this.tasks = new TaskRepository(db, clock);
    this.review = new ReviewRepository(db, clock);
    this.agents = new AgentRepository(db, clock);
    this.events = new EventRepository(db, clock);
    this.audit = new AuditRepository(db, clock);
    this.idempotency = new IdempotencyRepository(db, clock);
  }

  /** Run fn in one transaction. Events it emits reach open streams only after the commit. */
  tx<T>(fn: () => T): T {
    this.depth++;
    const mark = this.pending.length;
    try {
      const result = this.db.transaction(fn)();
      if (this.depth === 1) {
        const committed = this.pending;
        this.pending = [];
        for (const event of committed) this.bus.publish(event.project_id, { kind: 'event', event });
      }
      return result;
    } catch (error) {
      // A rolled-back (inner) transaction's events never happened.
      this.pending.length = mark;
      throw error;
    } finally {
      this.depth--;
    }
  }

  /** Append a project event inside the current transaction. */
  emit(projectId: string, type: ProjectEventType, payload: Record<string, unknown>): ProjectEventRecord {
    const event = this.events.append(projectId, type, payload);
    this.pending.push(event);
    return event;
  }

  /** Audit a mutation inside the current transaction. */
  record(actor: AuditActor, action: string, target: { type: string; id: string }, detail: Record<string, unknown> = {}, idempotencyKey?: string): void {
    this.audit.record({ actor, action, targetType: target.type, targetId: target.id, detail, idempotencyKey });
  }
}
