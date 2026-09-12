import { z } from 'zod';
import { TandemiseError, asId } from '@tandemise/shared';
import {
  addRepositoryRequest, cancelMissionRequest, connectIntegrationRequest, createIntegrationRequest, createMissionRequest,
  createRuntimeProfileRequest, createWorkspaceRequest, decideApprovalRequest, listMissionsQuery,
  missionEventsQuery, probeRepositoryRequest, retryTaskRequest, updateIntegrationRequest,
  updateRuntimeProfileRequest, updateWorkspaceRequest, upsertRoleRequest,
  completeTaskRequest,
} from '@tandemise/api-contract';
import type { TandemiseServices } from '@tandemise/application';
import { Router, formatZodIssues, type RequestContext } from './http/router.js';

/**
 * The daemon's HTTP surface.
 *
 * Handlers are thin on purpose: parse, delegate, return. Any handler that grows
 * a branch is a service method that has not been written yet. Keeping it this
 * way means the API is a projection of the application layer rather than a
 * second place where mission rules live.
 */
export function buildRouter(services: TandemiseServices): Router {
  const r = new Router();

  /**
   * Parses query parameters the same way `ctx.body()` parses bodies. A raw
   * ZodError escaping a handler is mapped to INTERNAL, which turns a mistyped
   * `?limit=9999` into a 500 with the whole issue array in the message.
   */
  const query = <T>(ctx: RequestContext, schema: z.ZodType<T>): T => {
    const parsed = schema.safeParse(Object.fromEntries(ctx.query));
    if (!parsed.success) throw TandemiseError.validation(formatZodIssues(parsed.error));
    return parsed.data;
  };

  const required = (ctx: RequestContext, name: string): string => {
    const value = ctx.query.get(name);
    if (!value) throw TandemiseError.validation(`Query parameter '${name}' is required.`);
    return value;
  };

  // ---------------------------------------------------------------- system
  r.get('/v1/system', () => services.system.info());
  r.get('/v1/settings', () => services.system.settings());
  r.patch('/v1/settings', async (ctx) =>
    services.system.updateSettings(await ctx.body(z.record(z.string(), z.unknown()))));
  r.get('/v1/diagnostics', () => services.system.diagnostics());

  // ------------------------------------------------------------ workspaces
  r.get('/v1/home', (ctx) => services.projections.home(ctx.query.get('workspaceId') ?? undefined));
  r.get('/v1/workspaces', () => services.workspaces.list());
  r.post('/v1/workspaces', async (ctx) => services.workspaces.create(await ctx.body(createWorkspaceRequest)));
  r.get('/v1/workspaces/:id', (ctx) => services.workspaces.view(asId(ctx.params.id!)));
  r.patch('/v1/workspaces/:id', async (ctx) =>
    services.workspaces.update(asId(ctx.params.id!), await ctx.body(updateWorkspaceRequest)));

  r.get('/v1/workspaces/:id/repositories', (ctx) => services.workspaces.listRepositories(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/repositories', async (ctx) =>
    services.workspaces.addRepository(asId(ctx.params.id!), await ctx.body(addRepositoryRequest)));
  r.post('/v1/repositories/probe', async (ctx) =>
    services.workspaces.probeRepository((await ctx.body(probeRepositoryRequest)).path));
  r.patch('/v1/repositories/:id', async (ctx) =>
    services.workspaces.updateRepository(asId(ctx.params.id!), await ctx.body(addRepositoryRequest.partial())));
  r.delete('/v1/repositories/:id', (ctx) => services.workspaces.removeRepository(asId(ctx.params.id!)));

  // --------------------------------------------------------------- missions
  r.get('/v1/missions', (ctx) => {
    return services.missions.list(query(ctx, listMissionsQuery));
  });
  r.post('/v1/missions', async (ctx) => services.missions.create(await ctx.body(createMissionRequest)));
  r.get('/v1/missions/:id', (ctx) => services.projections.missionDetail(asId(ctx.params.id!)));
  r.delete('/v1/missions/:id', (ctx) => services.missions.remove(asId(ctx.params.id!)));

  r.post('/v1/missions/:id/plan', (ctx) => services.planning.plan(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/start', (ctx) => services.missions.start(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/pause', (ctx) => services.missions.pause(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/resume', (ctx) => services.missions.resume(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/cancel', async (ctx) =>
    services.missions.cancel(asId(ctx.params.id!), (await ctx.body(cancelMissionRequest)).reason));

  r.get('/v1/missions/:id/events', (ctx) => {
    return services.projections.missionEvents(asId(ctx.params.id!), query(ctx, missionEventsQuery));
  });
  r.get('/v1/missions/:id/artifacts', (ctx) => services.artifacts.listByMission(asId(ctx.params.id!)));
  r.get('/v1/missions/:id/tasks', (ctx) => services.projections.missionTasks(asId(ctx.params.id!)));

  r.post('/v1/tasks/:id/retry', async (ctx) =>
    services.missions.retryTask(asId(ctx.params.id!), await ctx.body(retryTaskRequest)));
  r.post('/v1/tasks/:id/skip', (ctx) => services.missions.skipTask(asId(ctx.params.id!)));
  r.post('/v1/tasks/:id/complete', async (ctx) =>
    services.missions.completeTask(asId(ctx.params.id!), await ctx.body(completeTaskRequest)));

  // -------------------------------------------------------------- artifacts
  r.get('/v1/artifacts', (ctx) => {
    const workspaceId = ctx.query.get('workspaceId');
    return services.artifacts.search(workspaceId === null ? undefined : asId(workspaceId), ctx.query.get('q') ?? '');
  });
  r.get('/v1/artifacts/:id', (ctx) => services.artifacts.read(asId(ctx.params.id!)));

  // -------------------------------------------------------------- approvals
  r.get('/v1/approvals', (ctx) => services.approvals.list({
    workspaceId: ctx.query.get('workspaceId') ?? undefined,
    missionId: ctx.query.get('missionId') ?? undefined,
    status: ctx.query.get('status') ?? undefined,
  }));
  r.get('/v1/approvals/:id', (ctx) => services.approvals.get(asId(ctx.params.id!)));
  r.post('/v1/approvals/:id/decide', async (ctx) =>
    services.approvals.decide(asId(ctx.params.id!), await ctx.body(decideApprovalRequest)));

  // --------------------------------------------------------------- runtimes
  r.get('/v1/runtimes', (ctx) => services.runtimes.list(ctx.query.get('workspaceId') ?? undefined));
  r.post('/v1/runtimes/discover', () => services.runtimes.discover());
  r.post('/v1/runtimes', async (ctx) => services.runtimes.create(await ctx.body(createRuntimeProfileRequest)));
  r.patch('/v1/runtimes/:id', async (ctx) =>
    services.runtimes.update(asId(ctx.params.id!), await ctx.body(updateRuntimeProfileRequest)));
  r.delete('/v1/runtimes/:id', (ctx) => services.runtimes.remove(asId(ctx.params.id!)));
  r.post('/v1/runtimes/:id/health', (ctx) => services.runtimes.checkHealth(asId(ctx.params.id!)));

  // ------------------------------------------------------------------ roles
  r.get('/v1/roles', (ctx) => services.roles.list(ctx.query.get('workspaceId') ?? undefined));
  r.put('/v1/roles/:id', async (ctx) => {
    const body = await ctx.body(upsertRoleRequest);
    // The path names the resource; a body disagreeing with it is a client bug,
    // not a silent rename of a different role.
    if (body.id !== ctx.params.id) {
      throw TandemiseError.validation(`Role id in the path ('${ctx.params.id}') does not match the body ('${body.id}').`);
    }
    return services.roles.upsert(body);
  });
  r.delete('/v1/roles/:id', (ctx) =>
    services.roles.remove(ctx.params.id!, asId(required(ctx, 'workspaceId'))));

  // ------------------------------------------------------------- workflows
  // A project's own workflow files, then the built-in presets it has not
  // overridden. The path is returned so the UI can open a broken one.
  r.get('/v1/workflows', (ctx) => services.workflows.list(asId(required(ctx, 'workspaceId'))));

  // ----------------------------------------------------------- integrations
  r.get('/v1/integrations', (ctx) => {
    const workspaceId = ctx.query.get('workspaceId');
    return services.integrations.list(workspaceId === null ? undefined : asId(workspaceId));
  });
  r.get('/v1/integrations/providers', () => services.integrations.listProviders());
  r.get('/v1/integrations/connectors', () => services.integrations.listConnectors());
  r.post('/v1/integrations/connect', async (ctx) =>
    services.integrations.connect(await ctx.body(connectIntegrationRequest)));
  r.get('/v1/integrations/connect/:attemptId', (ctx) => services.integrations.connection(ctx.params.attemptId!));
  r.delete('/v1/integrations/connect/:attemptId', (ctx) =>
    services.integrations.cancelConnection(ctx.params.attemptId!));
  r.post('/v1/integrations', async (ctx) => services.integrations.create(await ctx.body(createIntegrationRequest)));
  r.patch('/v1/integrations/:id', async (ctx) =>
    services.integrations.update(asId(ctx.params.id!), await ctx.body(updateIntegrationRequest)));
  r.delete('/v1/integrations/:id', (ctx) => services.integrations.remove(asId(ctx.params.id!)));
  r.post('/v1/integrations/:id/health', (ctx) => services.integrations.checkHealth(asId(ctx.params.id!)));

  // --------------------------------------------------------------- machines
  r.get('/v1/targets', (ctx) => services.projections.targets(ctx.query.get('missionId') ?? undefined));

  return r;
}
