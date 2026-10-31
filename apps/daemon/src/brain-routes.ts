import { asId } from '@tandemise/shared';
import { applyBrainRequest, linkBrainRequest, shareBrainRequest } from '@tandemise/api-contract';
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
}
