import { asId } from '@tandemise/shared';
import {
  applyBrainRequest, brainEntriesQuery, linkBrainRequest, moveWorkflowRequest, promoteEntryRequest, rememberRequest, retireEntryRequest, shareBrainRequest, voteEntryRequest,
} from '@tandemise/api-contract';
import { TandemiseError } from '@tandemise/shared';
import type { TandemiseServices } from '@tandemise/application';
import type { Router } from './http/router.js';

/**
 * The brain's HTTP surface (#51 spec §12), beside the setup routes. Thin like
 * every handler: parse, delegate, return.
 */
export function brainRoutes(r: Router, services: TandemiseServices): void {
  r.get('/v1/workspaces/:id/brain', (ctx) => services.brain.view(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/brain', async (ctx) => services.brain.link(ctx.caller, asId(ctx.params.id!), await ctx.body(linkBrainRequest)));
  r.post('/v1/workspaces/:id/brain/link', async (ctx) => {
    const req = await ctx.body(applyBrainRequest);
    return services.brain.applyAdopt(ctx.caller, asId(ctx.params.id!), { hash: req.hash, choices: req.choices ?? {} });
  });
  r.post('/v1/workspaces/:id/brain/share', async (ctx) => services.brain.share(ctx.caller, asId(ctx.params.id!), await ctx.body(shareBrainRequest)));
  r.delete('/v1/workspaces/:id/brain', (ctx) => services.brain.unlink(ctx.caller, asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/brain/sync', (ctx) => services.brain.sync(asId(ctx.params.id!), 'person'));
  r.get('/v1/workspaces/:id/brain/factory', (ctx) => services.brain.factoryView(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/brain/factory/workflows', async (ctx) =>
    services.brain.moveWorkflowIn(ctx.caller, asId(ctx.params.id!), (await ctx.body(moveWorkflowRequest)).id));

  // Memory (spec §5, §7): lessons, Remember this, votes, accept/reject, retire.
  r.get('/v1/workspaces/:id/brain/entries', (ctx) => {
    const parsed = brainEntriesQuery.safeParse(Object.fromEntries(ctx.query));
    if (!parsed.success) throw TandemiseError.validation('Those filters are not valid.');
    return services.brain.entries(asId(ctx.params.id!), { scope: parsed.data.scope, state: parsed.data.state, includeHistory: parsed.data.history });
  });
  r.post('/v1/workspaces/:id/brain/entries', async (ctx) => services.brain.remember(ctx.caller, asId(ctx.params.id!), await ctx.body(rememberRequest)));
  r.post('/v1/brain/entries/:id/vote', async (ctx) => {
    const view = await services.brain.vote(ctx.caller, decodeURIComponent(ctx.params.id!), await ctx.body(voteEntryRequest));
    // Eligibility is checked after the fold: a lesson that keeps helping is proposed as a rule (spec §8).
    const found = services.brain.entry(view.id);
    if (found !== null) services.brain.proposeSoon(found.workspaceId);
    return view;
  });
  r.post('/v1/brain/entries/:id/accept', (ctx) => services.brain.accept(ctx.caller, decodeURIComponent(ctx.params.id!)));
  r.post('/v1/brain/entries/:id/reject', (ctx) => services.brain.reject(ctx.caller, decodeURIComponent(ctx.params.id!)));
  r.get('/v1/runs/:id/brain', (ctx) => services.brain.runBrain(ctx.params.id!));

  // Promotion (spec §8).
  r.get('/v1/workspaces/:id/brain/proposals', (ctx) => services.brain.proposalViews(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/brain/proposals', async (ctx) => services.brain.proposePromotions(asId(ctx.params.id!)));
  r.post('/v1/brain/entries/:id/promote', async (ctx) => services.brain.promoteEntry(ctx.caller, decodeURIComponent(ctx.params.id!), await ctx.body(promoteEntryRequest)));
  r.post('/v1/brain/proposals/:id/accept', (ctx) => services.brain.acceptProposal(ctx.caller, ctx.params.id!));
  r.post('/v1/brain/proposals/:id/decline', (ctx) => services.brain.declineProposal(ctx.caller, ctx.params.id!));
  r.post('/v1/brain/proposals/:id/revert', (ctx) => services.brain.revertProposal(ctx.caller, ctx.params.id!));
  r.post('/v1/brain/entries/:id/retire', async (ctx) => services.brain.retire(ctx.caller, decodeURIComponent(ctx.params.id!), await ctx.body(retireEntryRequest)));
}
