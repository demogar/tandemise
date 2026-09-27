import type {
  ArtifactRepositoryPort, CriteriaTrace, IssueCommentKind, IssueLink, IssueRepositoryPort, IssueSyncSettings, IssueTrackerPort,
  MemberRepositoryPort, Mission, MissionCriteriaRepositoryPort, MissionRepositoryPort, RepoRepositoryPort, Repository, UnitOfWork,
  UpstreamIssue, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  DEFAULT_ISSUE_LABEL, DEFAULT_ISSUE_POLL_MINUTES, ISSUE_CRITERIA_AUTHOR, MAX_ISSUES_PER_CHECK, decideWriteBack, githubRepoFromRemote,
  githubRepoProblem, hasIssueMarker, isTerminalMissionStatus, issueCheckLabel, issueClosedNote, issueCreatedNote, issueEditedNote, issueGoal,
  issueLabelProblem, issueMissionTitle, issuePollProblem, issueReopenedNote, parseIssueCriteria,
} from '@tandemise/domain';
import type {
  CreateMissionRequest, IssueLinkView, IssuesOverview, RepositoryIssuesView, UpdateIssueSettingsRequest,
} from '@tandemise/api-contract';
import type { Clock, IssueLinkId, Logger, MemberId, MissionId, RepositoryId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import { requireSeat, type Caller } from '../support/identity.js';

export interface IssueDeps {
  readonly issues: IssueRepositoryPort;
  /** GitHub through `gh`; the daemon binds the real one. */
  readonly tracker: IssueTrackerPort;
  readonly repositories: Pick<RepoRepositoryPort, 'get' | 'listByWorkspace'>;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get'>;
  readonly missions: Pick<MissionRepositoryPort, 'get' | 'list' | 'update'>;
  readonly members: MemberRepositoryPort;
  readonly criteria: MissionCriteriaRepositoryPort;
  readonly artifacts: Pick<ArtifactRepositoryPort, 'listByMission'>;
  /**
   * The one way an issue adds work: `MissionService.create`, queued only when
   * the issue stated its criteria, never planned from here.
   */
  readonly createMission: (caller: Caller, request: CreateMissionRequest, origin: { issueLinkId: IssueLinkId }) => Promise<Mission>;
  /** The backlog's own queue switch (P7), for a DRAFT. */
  readonly setQueued: (missionId: MissionId, queued: boolean) => void;
  /** The P5 trace, for the completion comment. */
  readonly trace: (missionId: MissionId) => CriteriaTrace;
  /** P9's verdict when the mission is stalled, else null. */
  readonly stalled: (missionId: MissionId) => { readonly reason: string; readonly action: string | null } | null;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

/** A write-back failure is retried no sooner than this. */
const RETRY_AFTER_MS = 60_000;
/** The background write-back pass runs at most this often; a check runs its own at once. */
const WRITE_BACK_EVERY_MS = 5_000;

/**
 * GitHub issues in and out (P14 spec §1).
 *
 * A check turns open labelled issues into drafts through `MissionService.create`
 * and nothing else: the readiness gate, the backlog pull and the limits decide
 * the rest, exactly as for a mission the person typed. Write-back derives what
 * each issue should say from the mission's current state and compares it with
 * what was stored, so it is idempotent across passes, restarts and crashes.
 *
 * Issue text is data. It becomes a mission's title, goal and criteria and is
 * echoed (escaped) into comments; settings come only from `configure`.
 */
export class IssueService {
  readonly #checking = new Map<RepositoryId, Promise<void>>();
  #writing: Promise<void> | null = null;
  #lastWriteBackMs = Number.NEGATIVE_INFINITY;
  /** Every `gh` write goes through this queue, so two passes never post the same comment. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #retryAfter = new Map<IssueLinkId, number>();
  readonly #viewers = new Map<string, string>();

  constructor(private readonly deps: IssueDeps) {}

  // ------------------------------------------------------------------ views

  overview(workspaceId: WorkspaceId): IssuesOverview {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    const links = this.deps.issues.listLinks({ workspaceId });
    const byLink = this.#missionsByLink(workspaceId);
    return {
      repositories: this.deps.repositories.listByWorkspace(workspaceId).map((r) => this.#repositoryView(r, links)),
      links: links.map((l) => linkView(l, byLink.get(l.id) ?? null)),
    };
  }

  repositoryView(repositoryId: RepositoryId): RepositoryIssuesView {
    const repository = this.#requireRepository(repositoryId);
    return this.#repositoryView(repository, this.deps.issues.listLinks({ repositoryId }));
  }

  /** The issue a mission came from, or null. */
  linkForMission(missionId: MissionId): IssueLinkView | null {
    const mission = this.deps.missions.get(missionId);
    if (mission?.issueLinkId === null || mission?.issueLinkId === undefined) return null;
    const link = this.deps.issues.getLink(mission.issueLinkId);
    return link === undefined ? null : linkView(link, mission.id);
  }

  // ------------------------------------------------------------------ settings

  configure(caller: Caller, repositoryId: RepositoryId, request: UpdateIssueSettingsRequest): RepositoryIssuesView {
    const repository = this.#requireRepository(repositoryId);
    const seat = requireSeat(this.deps, repository.workspaceId, caller);
    const current = this.deps.issues.settings(repositoryId);
    const githubRepo = request.githubRepo === undefined
      ? current?.githubRepo ?? githubRepoFromRemote(repository.remoteUrl)
      : request.githubRepo === null || request.githubRepo.trim() === '' ? null : request.githubRepo.trim();
    if (githubRepo !== null) {
      const problem = githubRepoProblem(githubRepo);
      if (problem !== null) throw TandemiseError.validation(problem, { githubRepo });
    }
    const label = request.label === undefined ? current?.label ?? DEFAULT_ISSUE_LABEL : request.label.trim();
    const labelProblem = issueLabelProblem(label);
    if (labelProblem !== null) throw TandemiseError.validation(labelProblem, { label });
    const pollMinutes = request.pollMinutes ?? current?.pollMinutes ?? DEFAULT_ISSUE_POLL_MINUTES;
    const pollProblem = issuePollProblem(pollMinutes);
    if (pollProblem !== null) throw TandemiseError.validation(pollProblem, { pollMinutes });
    const enabled = request.enabled ?? current?.enabled ?? false;
    if (enabled && githubRepo === null) {
      throw TandemiseError.validation('Say which GitHub repository to read issues from, as owner/name.');
    }
    if (enabled && githubRepo !== null) {
      // Two repositories reading one GitHub repository would link each issue twice.
      const clash = this.deps.issues.listSettings(repository.workspaceId).find((s) =>
        s.repositoryId !== repositoryId && s.enabled && s.githubRepo?.toLowerCase() === githubRepo.toLowerCase());
      if (clash !== undefined) {
        const other = this.deps.repositories.get(clash.repositoryId)?.name ?? 'another repository';
        throw new TandemiseError('CONFLICT', `${other} already reads issues from ${githubRepo}. Turn it off there first.`, {
          details: { repositoryId: clash.repositoryId },
        });
      }
    }
    const turnedOn = enabled && current?.enabled !== true;
    // A different source (repository or label) is checked again at once.
    const sourceChanged = current !== undefined && (current.githubRepo !== githubRepo || current.label !== label);
    this.deps.issues.saveSettings(repositoryId, repository.workspaceId, {
      enabled,
      githubRepo,
      label,
      pollMinutes,
      ...(request.closeOnComplete === undefined ? {} : { closeOnComplete: request.closeOnComplete }),
      ...(request.postComments === undefined ? {} : { postComments: request.postComments }),
      ...(request.workflowPreset === undefined ? {} : { workflowPreset: request.workflowPreset === null || request.workflowPreset.trim() === '' ? null : request.workflowPreset.trim() }),
      // Missions from issues are created as whoever switched it on (ruling 11).
      ...(turnedOn ? { enabledBy: seat.id } : {}),
      ...(turnedOn || sourceChanged ? { lastCheckedAt: null, lastError: null } : {}),
    });
    this.deps.log.info('issues.configured', { repositoryId, enabled, githubRepo, label, pollMinutes });
    this.#changed();
    return this.repositoryView(repositoryId);
  }

  // ------------------------------------------------------------------ checks

  /** "Check now": a fresh check of this repository, waited for. */
  async checkNow(caller: Caller, repositoryId: RepositoryId): Promise<RepositoryIssuesView> {
    const repository = this.#requireRepository(repositoryId);
    requireSeat(this.deps, repository.workspaceId, caller);
    const settings = this.deps.issues.settings(repositoryId);
    if (settings?.enabled !== true) {
      throw new TandemiseError('PRECONDITION_FAILED', 'Turn issues on for this repository first.', { details: { repositoryId } });
    }
    // One already running may have read the list before the issue the person just filed.
    await this.#checking.get(repositoryId);
    await this.check(repositoryId);
    return this.repositoryView(repositoryId);
  }

  /**
   * Scheduler hook: starts due checks and the write-back pass in the
   * background and returns at once, so a slow `gh` never holds up dispatch.
   */
  tick(): void {
    const nowMs = this.deps.clock.epochMs();
    for (const settings of this.deps.issues.listEnabled()) {
      if (this.#checking.has(settings.repositoryId)) continue;
      const last = settings.lastCheckedAt === null ? null : Date.parse(settings.lastCheckedAt);
      if (last === null || nowMs - last >= settings.pollMinutes * 60_000) void this.check(settings.repositoryId);
    }
    if (this.#writing === null && nowMs - this.#lastWriteBackMs >= WRITE_BACK_EVERY_MS) {
      this.#lastWriteBackMs = nowMs;
      this.#writing = this.writeBack()
        .catch((e: unknown) => { this.deps.log.warn('issues.write_back_crashed', { error: errorMessage(e) }); })
        .finally(() => { this.#writing = null; });
    }
  }

  /** Resolves when every check and write-back started so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    for (;;) {
      const pending = [...this.#checking.values(), ...(this.#writing === null ? [] : [this.#writing])];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** One check of one repository, then its write-back. Never rejects; errors are stored on the settings. */
  check(repositoryId: RepositoryId): Promise<void> {
    const running = this.#checking.get(repositoryId);
    if (running !== undefined) return running;
    // Never rejects: it runs detached from the tick, and a failure is already on the settings row.
    const run = this.#check(repositoryId).catch((e: unknown) => {
      this.deps.log.warn('issues.check_crashed', { repositoryId, error: errorMessage(e) });
    }).finally(() => {
      this.#checking.delete(repositoryId);
      this.#changed();
    });
    this.#checking.set(repositoryId, run);
    this.#changed();
    return run;
  }

  /** Brings every linked issue up to date with its mission. Never rejects. */
  async writeBack(): Promise<void> {
    for (const settings of this.deps.issues.listEnabled()) {
      await this.#writeBackRepository(settings.repositoryId);
    }
  }

  async #check(repositoryId: RepositoryId): Promise<void> {
    const settings = this.deps.issues.settings(repositoryId);
    const repository = this.deps.repositories.get(repositoryId);
    if (settings === undefined || !settings.enabled || settings.githubRepo === null || repository === undefined) return;
    const repo = settings.githubRepo;
    const problems: string[] = [];
    try {
      const caller = this.#callerFor(settings);
      const open = await this.deps.tracker.listOpen({ repo, label: settings.label, limit: MAX_ISSUES_PER_CHECK, cwd: repository.path });
      const seen = new Set<number>();
      for (const issue of open) {
        seen.add(issue.number);
        try {
          await this.#absorb(settings, repository, issue, caller);
        } catch (e) {
          problems.push(`#${issue.number}: ${errorMessage(e)}`);
          this.deps.log.warn('issues.absorb_failed', { repositoryId, number: issue.number, error: errorMessage(e) });
        }
      }
      // Open before, missing now: closed upstream, or the label was taken off.
      for (const link of this.deps.issues.listLinks({ repositoryId })) {
        if (link.state !== 'open' || seen.has(link.number)) continue;
        const upstream = await this.deps.tracker.view({ repo, number: link.number, cwd: repository.path });
        if (upstream.state === 'CLOSED') this.#closedUpstream(link);
        else this.deps.issues.updateLink(link.id, { state: 'unlabelled' });
      }
      this.deps.issues.saveSettings(repositoryId, repository.workspaceId, {
        lastCheckedAt: this.deps.clock.now(),
        lastError: problems.length === 0 ? null : `Could not add every issue: ${problems.join('; ')}`,
      });
    } catch (e) {
      this.deps.issues.saveSettings(repositoryId, repository.workspaceId, {
        lastCheckedAt: this.deps.clock.now(),
        lastError: `Could not check issues: ${errorMessage(e)}`,
      });
      this.deps.log.warn('issues.check_failed', { repositoryId, error: errorMessage(e) });
    }
    await this.#writeBackRepository(repositoryId);
  }

  /** One open labelled issue: a new draft, a finished crash, a reopen, or an edit. */
  async #absorb(settings: IssueSyncSettings, repository: Repository, issue: UpstreamIssue, caller: Caller): Promise<void> {
    const repo = settings.githubRepo ?? '';
    let link = this.deps.issues.findLink(repository.id, issue.number);
    if (link === undefined) {
      try {
        link = this.deps.issues.createLink({
          workspaceId: repository.workspaceId, repositoryId: repository.id, githubRepo: repo, number: issue.number, url: issue.url,
          title: issue.title, body: issue.body, author: issue.author, upstreamUpdatedAt: issue.updatedAt, state: 'open',
          criteriaCount: parseIssueCriteria(issue.body).length,
        });
      } catch (e) {
        // The UNIQUE (repository, number) index: someone else linked it first.
        if (this.deps.issues.findLink(repository.id, issue.number) !== undefined) return;
        throw e;
      }
      await this.#createDraft(settings, repository, link, issue, caller);
      return;
    }
    if (link.status === 'pending') {
      // Stopped between the link and its mission: finish, never duplicate.
      await this.#createDraft(settings, repository, link, issue, caller);
      return;
    }
    if (link.state !== 'open') {
      const mission = this.#missionOf(link);
      if (link.state === 'closed' && mission !== undefined) this.#note(mission, issueReopenedNote(link.number));
      link = this.deps.issues.updateLink(link.id, { state: 'open' });
    }
    if (issue.title !== link.title || issue.body !== link.body) this.#edited(link, issue);
  }

  async #createDraft(settings: IssueSyncSettings, repository: Repository, link: IssueLink, issue: UpstreamIssue, caller: Caller): Promise<void> {
    const repo = settings.githubRepo ?? link.githubRepo;
    if (this.#missionOf(link) === undefined) {
      const criteria = parseIssueCriteria(issue.body);
      const mission = await this.deps.createMission(caller, {
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
        title: issueMissionTitle(issue),
        goal: issueGoal(repo, issue),
        successCriteria: [...criteria],
        // Queued only when the issue says what done means: ready by construction.
        queued: criteria.length > 0,
        ...(settings.workflowPreset === null ? {} : { workflowPreset: settings.workflowPreset }),
      }, { issueLinkId: link.id });
      this.#note(mission, issueCreatedNote(issue, criteria.length));
      this.deps.log.info('issues.created_mission', { repositoryId: repository.id, number: issue.number, missionId: mission.id, criteria: criteria.length });
    }
    this.deps.issues.updateLink(link.id, { status: 'linked' });
  }

  /** The issue's title or body changed upstream. */
  #edited(link: IssueLink, issue: UpstreamIssue): void {
    const criteria = parseIssueCriteria(issue.body);
    this.deps.issues.updateLink(link.id, {
      title: issue.title, body: issue.body, author: issue.author, upstreamUpdatedAt: issue.updatedAt, criteriaCount: criteria.length,
    });
    const mission = this.#missionOf(link);
    if (mission === undefined || isTerminalMissionStatus(mission.status)) return;
    if (mission.status !== 'DRAFT') {
      // A running mission is never rewritten; the person reads the change on GitHub.
      this.#note(mission, issueEditedNote(link.number, true));
      return;
    }
    this.deps.unitOfWork.transaction(() => {
      this.deps.missions.update(mission.id, {
        title: issueMissionTitle(issue), goal: issueGoal(link.githubRepo, issue), successCriteria: [...criteria],
      });
      const fromIssue = this.deps.criteria.listActive(mission.id)
        .filter((c) => c.source === 'user' && c.decidedBy === ISSUE_CRITERIA_AUTHOR).map((c) => c.statement);
      // Only the lines that came from the issue; the person's own stay (ruling 6).
      if (JSON.stringify(fromIssue) !== JSON.stringify(criteria)) {
        this.deps.criteria.replaceUserCriteriaBy(mission.id, ISSUE_CRITERIA_AUTHOR, criteria);
      }
    });
    this.#note(mission, issueEditedNote(link.number, false));
    const accepted = this.deps.criteria.listActive(mission.id).filter((c) => c.source === 'user').length;
    if (mission.queuedAt !== null && accepted === 0) this.deps.setQueued(mission.id, false);
    else if (mission.queuedAt === null && link.criteriaCount === 0 && criteria.length > 0) this.deps.setQueued(mission.id, true);
  }

  #closedUpstream(link: IssueLink): void {
    this.deps.issues.updateLink(link.id, { state: 'closed' });
    const mission = this.#missionOf(link);
    if (mission === undefined || isTerminalMissionStatus(mission.status)) return;
    if (mission.status === 'DRAFT') {
      const queued = mission.queuedAt !== null;
      if (queued) this.deps.setQueued(mission.id, false);
      this.#note(mission, issueClosedNote(link.number, true, queued));
    } else {
      this.#note(mission, issueClosedNote(link.number, false, false));
    }
  }

  // ------------------------------------------------------------------ write-back

  #writeBackRepository(repositoryId: RepositoryId): Promise<void> {
    return this.#exclusive(async () => {
      const settings = this.deps.issues.settings(repositoryId);
      const repository = this.deps.repositories.get(repositoryId);
      if (settings === undefined || !settings.enabled || repository === undefined) return;
      const nowMs = this.deps.clock.epochMs();
      const byLink = this.#missionsByLink(repository.workspaceId);
      for (const link of this.deps.issues.listLinks({ repositoryId })) {
        if (link.status !== 'linked' || (this.#retryAfter.get(link.id) ?? 0) > nowMs) continue;
        const missionId = byLink.get(link.id);
        const mission = missionId === undefined ? undefined : this.deps.missions.get(asId<'MissionId'>(missionId));
        if (mission === undefined) continue;
        try {
          await this.#bringUpToDate(settings, repository, link, mission);
          this.#retryAfter.delete(link.id);
        } catch (e) {
          this.#retryAfter.set(link.id, nowMs + RETRY_AFTER_MS);
          this.deps.issues.saveSettings(repositoryId, repository.workspaceId, { lastError: `Could not update issue #${link.number}: ${errorMessage(e)}` });
          this.deps.log.warn('issues.write_back_failed', { repositoryId, number: link.number, error: errorMessage(e) });
          this.#changed();
        }
      }
    });
  }

  async #bringUpToDate(settings: IssueSyncSettings, repository: Repository, link: IssueLink, mission: Mission): Promise<void> {
    const complete = mission.status === 'COMPLETE';
    const live = !isTerminalMissionStatus(mission.status) && mission.status !== 'DRAFT';
    const plan = decideWriteBack({
      settings,
      link,
      mission: { status: mission.status, queued: mission.queuedAt !== null },
      criteria: this.deps.criteria.listActive(mission.id).filter((c) => c.source === 'user').map((c) => ({ key: c.key, statement: c.statement })),
      trace: complete ? this.deps.trace(mission.id).rows.map((r) => ({ key: r.criterion.key, statement: r.criterion.statement, result: r.result })) : [],
      links: complete ? this.#deliveryLinks(mission.id) : [],
      stalled: live ? this.deps.stalled(mission.id) : null,
      posted: Object.fromEntries(this.deps.issues.comments(link.id).map((c) => [c.kind, c.body])),
    });
    if (plan.comments.length === 0 && !plan.close && plan.stallOpen === link.stallOpen) return;
    const cwd = repository.path;
    for (const comment of plan.comments) await this.#write(link, comment.kind, comment.body, cwd);
    if (plan.close) {
      await this.deps.tracker.close({ repo: link.githubRepo, number: link.number, cwd });
      this.deps.issues.updateLink(link.id, { closedByUsAt: this.deps.clock.now() });
      this.#note(mission, `Closed GitHub issue #${link.number}: every criterion was verified.`);
    }
    if (plan.stallOpen !== link.stallOpen) this.deps.issues.updateLink(link.id, { stallOpen: plan.stallOpen });
    if (plan.comments.length > 0) this.#changed();
  }

  /** Updates this kind's comment, adopts one posted before a crash, or posts it. */
  async #write(link: IssueLink, kind: IssueCommentKind, body: string, cwd: string): Promise<void> {
    const repo = link.githubRepo;
    const stored = this.deps.issues.comments(link.id).find((c) => c.kind === kind);
    if (stored !== undefined) {
      try {
        await this.deps.tracker.updateComment({ repo, commentId: stored.commentId, body, cwd });
        this.deps.issues.saveComment(link.id, kind, stored.commentId, body);
        return;
      } catch (e) {
        // Deleted on GitHub: post a fresh one below. Anything else is retried later.
        if (!(e instanceof TandemiseError) || e.code !== 'NOT_FOUND') throw e;
        this.deps.issues.dropComment(link.id, kind);
      }
    }
    // Posted but not recorded (a stop in between): adopt our own marked comment (ruling 8).
    const me = await this.#viewer(repo, cwd);
    const mine = (await this.deps.tracker.comments({ repo, number: link.number, cwd }))
      .find((c) => c.author === me && hasIssueMarker(c.body, kind));
    if (mine !== undefined) {
      if (mine.body !== body) await this.deps.tracker.updateComment({ repo, commentId: mine.id, body, cwd });
      this.deps.issues.saveComment(link.id, kind, mine.id, body);
      return;
    }
    const id = await this.deps.tracker.postComment({ repo, number: link.number, body, cwd });
    this.deps.issues.saveComment(link.id, kind, id, body);
  }

  async #viewer(repo: string, cwd: string): Promise<string> {
    const host = repo.split('/').length === 3 ? repo.split('/')[0] ?? '' : 'github.com';
    const known = this.#viewers.get(host);
    if (known !== undefined) return known;
    const login = await this.deps.tracker.viewer({ repo, cwd });
    this.#viewers.set(host, login);
    return login;
  }

  /** Pull request and branch links from the mission's handoffs, first mention wins. */
  #deliveryLinks(missionId: MissionId): { label: string; url: string }[] {
    const out: { label: string; url: string }[] = [];
    for (const manifest of this.deps.artifacts.listByMission(missionId)) {
      for (const link of manifest.handoff?.links ?? []) {
        const branch = /\/tree\//.test(link.url);
        if ((link.kind === 'pr' || branch) && /^https?:\/\//.test(link.url) && !out.some((l) => l.url === link.url)) {
          out.push({ label: link.kind === 'pr' ? `Pull request (${link.label})` : `Branch (${link.label})`, url: link.url });
        }
      }
      for (const ref of manifest.sourceRefs) {
        if (ref.kind === 'github.pr' && /^https?:\/\//.test(ref.value) && !out.some((l) => l.url === ref.value)) {
          out.push({ label: `Pull request${ref.label === undefined ? '' : ` (${ref.label})`}`, url: ref.value });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ helpers

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #missionsByLink(workspaceId: WorkspaceId): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of this.deps.missions.list({ workspaceId })) {
      if (m.issueLinkId !== null && m.issueLinkId !== undefined && !map.has(m.issueLinkId)) map.set(m.issueLinkId, m.id);
    }
    return map;
  }

  #missionOf(link: IssueLink): Mission | undefined {
    const id = this.#missionsByLink(link.workspaceId).get(link.id);
    return id === undefined ? undefined : this.deps.missions.get(asId<'MissionId'>(id));
  }

  #repositoryView(repository: Repository, links: readonly IssueLink[]): RepositoryIssuesView {
    const s = this.deps.issues.settings(repository.id);
    const linked = links.filter((l) => l.repositoryId === repository.id).length;
    const checking = this.#checking.has(repository.id);
    return {
      repositoryId: repository.id,
      repositoryName: repository.name,
      settings: {
        enabled: s?.enabled ?? false,
        githubRepo: s?.githubRepo ?? null,
        label: s?.label ?? DEFAULT_ISSUE_LABEL,
        pollMinutes: s?.pollMinutes ?? DEFAULT_ISSUE_POLL_MINUTES,
        closeOnComplete: s?.closeOnComplete ?? false,
        postComments: s?.postComments ?? true,
        workflowPreset: s?.workflowPreset ?? null,
        lastCheckedAt: s?.lastCheckedAt ?? null,
        lastError: s?.lastError ?? null,
      },
      suggestedRepo: githubRepoFromRemote(repository.remoteUrl),
      statusLabel: issueCheckLabel({
        enabled: s?.enabled ?? false,
        checking,
        lastCheckedMs: s?.lastCheckedAt ? Date.parse(s.lastCheckedAt) : null,
        nowMs: this.deps.clock.epochMs(),
        linked,
      }),
      linked,
      checking,
    };
  }

  /** The member who switched issues on; a check never acts under someone else's name (ruling 11). */
  #callerFor(settings: IssueSyncSettings): Caller {
    const member = settings.enabledBy === null ? undefined : this.deps.members.get(asId<'MemberId'>(settings.enabledBy) as MemberId);
    if (member === undefined || member.personId === null || member.status !== 'active') {
      throw new TandemiseError('PRECONDITION_FAILED', 'The person who turned issues on is no longer on the team. Turn it off and on again to take it over.');
    }
    return { personId: member.personId };
  }

  #requireRepository(id: RepositoryId): Repository {
    const repository = this.deps.repositories.get(id);
    if (repository === undefined) throw TandemiseError.notFound('Repository', id);
    return repository;
  }

  #note(mission: Mission, text: string): void {
    this.deps.recorder.note({ workspaceId: mission.workspaceId, missionId: mission.id }, text);
    this.deps.recorder.invalidate('missions', mission.id);
  }

  /** The Issues section and the chips live on missions pages and the project page. */
  #changed(): void {
    this.deps.recorder.invalidate('missions');
  }
}

function linkView(link: IssueLink, missionId: string | null): IssueLinkView {
  return {
    id: link.id,
    repositoryId: link.repositoryId,
    githubRepo: link.githubRepo,
    number: link.number,
    url: link.url,
    title: link.title,
    author: link.author,
    state: link.state,
    missionId,
  };
}
