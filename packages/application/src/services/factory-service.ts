import type { MissionDetail, PlanChipView, PlanDecisionView, ShipPullRequestView, ShipView } from '@tandemise/api-contract';
import {
  isTerminalMissionStatus, laneBecauseSentence, laneLine, moduleSentence, profileChips, profileLine, signalSentence, stepLine, tiebreakSentence,
  type EventRepositoryPort, type MissionRepositoryPort, type MissionTask, type PlanDecision, type PlanDecisionRepositoryPort,
  type ProfileSignal, type TaskRepositoryPort,
} from '@tandemise/domain';
import { TandemiseError, type MissionId } from '@tandemise/shared';
import type { PlannerService } from '../planning/planner-service.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { Caller } from '../support/identity.js';
import type { PlanningService, ProjectionService } from '../services.js';
import type { ReadinessService } from './readiness.js';

export interface FactoryServiceDeps {
  readonly planner: PlannerService;
  readonly planning: PlanningService;
  readonly projections: Pick<ProjectionService, 'missionDetail'>;
  readonly readiness: Pick<ReadinessService, 'evaluate'>;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly events: Pick<EventRepositoryPort, 'listByMission'>;
  readonly recorder: EventRecorder;
}

const STARTABLE: readonly string[] = ['PENDING', 'READY'];

/**
 * The factory as the person sees it (#53 §10, §11): "Why these steps", Plan
 * quick or careful, a lane switch, and the pull request the ship step opened.
 * Every sentence is made here, so the renderer only shows it.
 */
export class FactoryService {
  constructor(private readonly deps: FactoryServiceDeps) {}

  /**
   * Plan, or Plan quick / Plan careful. A lane is stored with the mission
   * before planning. Careful work with no Done-when line isn't planned: it
   * stays a draft to get ready (#53 §4), and the feed says why.
   */
  async plan(missionId: MissionId, lane: 'quick' | 'careful' | undefined, caller: Caller): Promise<MissionDetail> {
    void caller;
    let mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    if (lane !== undefined) {
      if (!this.deps.planner.handles(mission)) {
        throw new TandemiseError('PRECONDITION_FAILED', 'Plan quick and Plan careful are for missions the factory plans; this one follows its own workflow.', { details: { missionId } });
      }
      mission = this.deps.missions.update(missionId, { laneRequest: lane });
      this.deps.recorder.invalidate('missions', missionId);
    }
    if (mission.status === 'DRAFT' && this.deps.planner.handles(mission)) {
      await this.deps.planner.warm(missionId);
      if (!this.deps.planner.skipsReadiness(mission) && !this.deps.readiness.evaluate(missionId).ready) {
        const scope: EventScope = { workspaceId: mission.workspaceId, missionId };
        this.deps.recorder.note(scope, 'This is careful work, so it is planned once it says what done means. Add a Done-when line under Get it ready, then plan it.');
        return this.deps.projections.missionDetail(missionId);
      }
    }
    return this.deps.planning.begin(missionId);
  }

  async planDecision(missionId: MissionId): Promise<PlanDecisionView | null> {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    const decision = this.deps.planDecisions.latest(missionId);
    if (decision === undefined) return null;
    const tasks = this.deps.tasks.listByMission(missionId);
    let modules: readonly { readonly name: string; readonly when: string; readonly add: unknown }[] = [];
    try {
      modules = (await this.deps.planner.config(mission.workspaceId)).planner.modules;
    } catch { /* the names alone still say which rules applied */ }
    const ship = tasks.find((t) => t.executor === 'ship');
    const open = ship !== undefined && STARTABLE.includes(ship.status) && !isTerminalMissionStatus(mission.status);
    const titles = new Map(tasks.map((t) => [t.key, t.title]));
    return {
      missionId,
      lane: decision.lane,
      profileLine: profileLine(decision.profile),
      chips: chips(decision),
      // A lane raised by the measured change never had a plan approval: say so, not the careful lane's usual line.
      laneLine: laneLine(decision.lane, decision.steps.filter((s) => s.stepClass !== 'ship').length + 1, decision.basis === 'measured' && decision.skipped.includes('No plan approval.') && decision.lane !== 'quick'),
      laneBecause: laneBecauseSentence(decision.laneBecause),
      skipped: decision.skipped,
      modules: decision.modules.map((name) => moduleSentence(
        modules.find((m) => m.name === name) as Parameters<typeof moduleSentence>[0], name, decision.profile,
      )),
      dropped: decision.dropped.map((d) => `${d.name}: ${d.why}`),
      steps: decision.steps.filter((s) => s.stepClass !== 'ship').map((s) => ({ key: s.key, line: stepLine(s, titles.get(s.key)) })),
      tiebreak: decision.tiebreak === null ? null : tiebreakSentence(decision.tiebreak),
      lightenedByPerson: decision.lightenedByPerson,
      canMakeQuick: open && decision.lane !== 'quick',
      canMakeCareful: open && decision.lane !== 'careful',
      measured: decision.basis === 'measured',
    };
  }

  /** Make it quick (asks first, through a plan card) or Make it careful (adds steps now). */
  async setLane(missionId: MissionId, lane: 'quick' | 'careful', caller: Caller): Promise<PlanDecisionView | null> {
    await this.deps.planner.switchLane(missionId, lane, caller);
    this.deps.recorder.invalidate('tasks', missionId);
    return this.planDecision(missionId);
  }

  /** The ship step and the pull requests it opened (part 1: no CI or merge yet). */
  ship(missionId: MissionId): ShipView {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    const tasks = this.deps.tasks.listByMission(missionId);
    const ship = [...tasks].reverse().find((t) => t.executor === 'ship');
    const opened = new Map<string, ShipPullRequestView>();
    for (const event of this.deps.events.listByMission(missionId, { semanticOnly: true })) {
      if (event.body.type !== 'ship.pr_opened') continue;
      const { repo, number, url } = event.body;
      opened.set(`${repo}#${number}`, { repo, number, url, state: 'opened' });
    }
    const prs = [...opened.values()];
    return { missionId, taskId: ship?.id ?? null, prs, ...shipStage(ship, prs.length) };
  }
}

function shipStage(ship: MissionTask | undefined, prs: number): Pick<ShipView, 'stage' | 'headline' | 'status'> {
  if (ship === undefined) return { stage: 'none', headline: 'No pull request', status: 'This mission has no ship step.' };
  if (prs > 0 && ship.status !== 'RUNNING') {
    return { stage: 'opened', headline: 'Pull request opened', status: prs === 1 ? 'The pull request is open on GitHub.' : `${prs} pull requests are open on GitHub.` };
  }
  switch (ship.status) {
    case 'RUNNING':
      return { stage: 'opening', headline: 'Opening the pull request', status: ship.statusReason ?? 'Opening the pull request.' };
    case 'SUCCEEDED':
      return { stage: 'opened', headline: 'Pull request opened', status: ship.statusReason ?? 'The pull request is open.' };
    case 'SKIPPED':
      return { stage: 'skipped', headline: 'No pull request', status: ship.statusReason ?? 'Nothing was shipped.' };
    case 'CANCELLED':
      return { stage: 'cancelled', headline: 'No pull request', status: 'The mission stopped before the pull request opened.' };
    case 'BLOCKED':
    case 'FAILED':
      return { stage: 'blocked', headline: "Couldn't open the pull request", status: ship.statusReason ?? "The pull request couldn't be opened." };
    default:
      return { stage: 'waiting', headline: 'Pull request not open yet', status: 'The pull request opens once the steps before it are done.' };
  }
}

/** The three chips, each with the signals that set it. */
function chips(decision: PlanDecision): readonly PlanChipView[] {
  const [type, size, risk] = profileChips(decision.profile);
  const about = (s: ProfileSignal, what: 'type' | 'size' | 'risk'): boolean => {
    const effect = s.effect.replace(/^disagrees:\s*/, '');
    if (what === 'risk') return effect.startsWith('risk ') || effect.startsWith('area ') || effect.startsWith('conservative default');
    return effect.startsWith(`${what} `);
  };
  const of = (what: 'type' | 'size' | 'risk') => decision.profile.signals.filter((s) => about(s, what)).map(signalSentence);
  return [{ label: type, signals: of('type') }, { label: size, signals: of('size') }, { label: risk, signals: of('risk') }];
}
