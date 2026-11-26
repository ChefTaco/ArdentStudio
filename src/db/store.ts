import type { Db } from './database.js';
import type { Clock } from './json.js';
import { AgentRepository } from './repos/agents.js';
import { AuditRepository, type AuditActor } from './repos/audit.js';
import { EventRepository, type ProjectEventRecord } from './repos/events.js';
import { FileRepository } from './repos/files.js';
import { IdempotencyRepository } from './repos/idempotency.js';
import { LinkRepository } from './repos/links.js';
import { MembershipRepository } from './repos/members.js';
import { ProjectRepository } from './repos/projects.js';
import { TeamProposalRepository } from './repos/proposals.js';
import { purgeProjectRows, type PurgedRows } from './repos/purge.js';
import { KnowledgeRetirementRepository } from './repos/retirements.js';
import { ReviewRepository } from './repos/review.js';
import { RoomRepository } from './repos/room.js';
import { SessionRepository } from './repos/sessions.js';
import { COUNT_EVENT_TYPES, ProjectSummaryRepository } from './repos/summaries.js';
import { TaskRepository } from './repos/tasks.js';
import { TeamRepository } from './repos/team.js';
import { TemplateRepository } from './repos/templates.js';
import { WorkflowRepository } from './repos/workflows.js';
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
  readonly sessions: SessionRepository;
  readonly review: ReviewRepository;
  readonly agents: AgentRepository;
  readonly events: EventRepository;
  readonly audit: AuditRepository;
  readonly idempotency: IdempotencyRepository;
  readonly links: LinkRepository;
  readonly proposals: TeamProposalRepository;
  readonly summaries: ProjectSummaryRepository;
  readonly workflows: WorkflowRepository;
  readonly members: MembershipRepository;
  readonly retirements: KnowledgeRetirementRepository;
  private pending: ProjectEventRecord[] = [];
  private depth = 0;

  constructor(readonly db: Db, readonly clock: Clock, private readonly bus: EventBus) {
    this.projects = new ProjectRepository(db, clock);
    this.files = new FileRepository(db, clock);
    this.templates = new TemplateRepository(db, clock);
    this.team = new TeamRepository(db, clock);
    this.room = new RoomRepository(db, clock);
    this.tasks = new TaskRepository(db, clock);
    this.sessions = new SessionRepository(db, clock);
    this.review = new ReviewRepository(db, clock);
    this.agents = new AgentRepository(db, clock);
    this.events = new EventRepository(db, clock);
    this.audit = new AuditRepository(db, clock);
    this.idempotency = new IdempotencyRepository(db, clock);
    this.links = new LinkRepository(db, clock);
    this.proposals = new TeamProposalRepository(db, clock);
    this.summaries = new ProjectSummaryRepository(db);
    this.workflows = new WorkflowRepository(db, clock);
    this.members = new MembershipRepository(db, clock);
    this.retirements = new KnowledgeRetirementRepository(db, clock);
  }

  /**
   * Run fn in one transaction. Events it emits reach open streams only after the commit. When they
   * can change a project's counts, the outermost transaction recounts and, on a change, also emits
   * project.updated with the new counts before it commits.
   */
  tx<T>(fn: () => T): T {
    this.depth++;
    const mark = this.pending.length;
    try {
      const result = this.db.transaction(() => {
        const value = fn();
        if (this.depth === 1) this.announceCounts();
        return value;
      })();
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

  private announceCounts(): void {
    const projects = new Set(this.pending.filter(event => COUNT_EVENT_TYPES.has(event.type)).map(event => event.project_id));
    for (const projectId of projects) {
      const counts = this.summaries.recount(projectId);
      if (counts) this.emit(projectId, 'project.updated', { fields: ['counts'], counts });
    }
  }

  /** Append a project event inside the current transaction. */
  emit(projectId: string, type: ProjectEventType, payload: Record<string, unknown>): ProjectEventRecord {
    const event = this.events.append(projectId, type, payload);
    this.pending.push(event);
    return event;
  }

  /**
   * Delete every row of a project and queue the retirement of its HiveMem sources, inside the
   * current transaction. Events it emitted earlier in the transaction are dropped: they are gone.
   */
  purgeProject(projectId: string): PurgedRows & { sourcesRetiring: number } {
    const rows = purgeProjectRows(this.db, projectId);
    this.pending = this.pending.filter(event => event.project_id !== projectId);
    return { ...rows, sourcesRetiring: this.retirements.queue(rows.retirements) };
  }

  /** Audit a mutation inside the current transaction. */
  record(actor: AuditActor, action: string, target: { type: string; id: string }, detail: Record<string, unknown> = {}, idempotencyKey?: string): void {
    this.audit.record({ actor, action, targetType: target.type, targetId: target.id, detail, idempotencyKey });
  }
}
