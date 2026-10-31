import type { CoordinationExportLine, ImportReport } from '@tandemise/api-contract/relay';
import { CoordError, type CoordinationStore } from './store.js';
import { COORD_SCHEMA_VERSION } from './migrations.js';
import { createEndpoint, storeRequest, unackedMessages, type EndpointRow } from './mailbox.js';

/**
 * Export as JSON lines, meta first (spec §Moving from solo to a relay). The
 * same format backs a relay up, moves between relays, and brings a solo
 * daemon's data up to a new relay.
 */
export function exportLines(store: CoordinationStore, opts: { claimsOf?: string } = {}): string[] {
  const lines: CoordinationExportLine[] = [];
  lines.push({ kind: 'meta', schemaVersion: COORD_SCHEMA_VERSION, teamName: store.team()?.name ?? 'Team' });
  for (const r of store.stmt(`SELECT * FROM coord_members ORDER BY created_at, id`).all() as
    { id: string; display_name: string; handles: string; role: 'admin' | 'member'; status: 'active' | 'removed'; created_at: string }[]) {
    lines.push({ kind: 'member', id: r.id, displayName: r.display_name, handles: JSON.parse(r.handles) as Record<string, string>, role: r.role, status: r.status, createdAt: r.created_at });
  }
  for (const c of store.activeClaims()) {
    if (opts.claimsOf && c.memberId !== opts.claimsOf) continue;
    lines.push({
      kind: 'claim', id: c.id, projectKey: c.projectKey, itemRef: c.itemRef, itemTitle: c.itemTitle, itemUrl: c.itemUrl,
      memberId: c.memberId, memberName: c.memberName, localRef: c.localRef, startedAt: c.startedAt,
    });
  }
  for (const e of store.stmt(`SELECT * FROM coord_endpoints ORDER BY created_at, id`).all() as EndpointRow[]) {
    lines.push({
      kind: 'endpoint', id: e.id, projectKey: e.project_key, slug: e.slug, name: e.name, source: e.source, handshake: e.handshake,
      handshakeSecret: e.handshake_secret, createdAt: e.created_at, disabledAt: e.disabled_at,
    });
  }
  for (const m of unackedMessages(store)) {
    lines.push({
      kind: 'message', id: m.id, endpointId: m.endpointId, receivedAt: m.receivedAt, method: m.method, query: m.query,
      headers: m.headers, contentType: m.contentType, bodyBase64: m.bodyBase64, attempts: 0,
    });
  }
  return lines.map((l) => JSON.stringify(l));
}

function parseLines(lines: readonly string[]): CoordinationExportLine[] {
  const parsed = lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as CoordinationExportLine);
  const meta = parsed[0];
  if (!meta || meta.kind !== 'meta') throw new CoordError('relay_not_empty', 'That is not a Tandemise coordination export: it has no header line.');
  if (meta.schemaVersion > COORD_SCHEMA_VERSION) {
    throw new CoordError('relay_not_empty', `That export is from a newer version (${meta.schemaVersion}). Update first.`);
  }
  return parsed;
}

/**
 * Imports an export.
 *
 * - `empty`: only into an empty store, all or nothing. With an `actor`, the
 *   claims become the actor's (a solo person bringing their own data up);
 *   without one (a restore from the CLI), members keep their ids.
 * - `own-claims`: only the claim lines, each through normal `claim()`, so a
 *   conflict is reported per item.
 */
export function importLines(
  store: CoordinationStore,
  lines: readonly string[],
  mode: 'empty' | 'own-claims',
  actor: { memberId: string; deviceId: string } | null,
): ImportReport {
  const parsed = parseLines(lines);
  const claims: { itemRef: string; result: 'claimed' | 'held'; holderName?: string }[] = [];
  const claimOne = (c: Extract<CoordinationExportLine, { kind: 'claim' }>) => {
    const out = store.claim({
      projectKey: c.projectKey, itemRef: c.itemRef, itemTitle: c.itemTitle, itemUrl: c.itemUrl, localRef: c.localRef ?? '',
      memberId: actor?.memberId ?? c.memberId, deviceId: actor?.deviceId ?? '', startedAt: c.startedAt,
    });
    claims.push(out.kind === 'claimed' ? { itemRef: out.claim.itemRef, result: 'claimed' } : { itemRef: out.claim.itemRef, result: 'held', holderName: out.claim.memberName });
  };
  if (mode === 'own-claims') {
    for (const l of parsed) if (l.kind === 'claim') claimOne(l);
    return { claims, endpoints: 0, messages: 0 };
  }
  return store.tx(() => {
    if (!store.isEmpty()) throw new CoordError('relay_not_empty', 'This relay already has data, so only your own claims can be brought up.');
    let endpoints = 0;
    let messages = 0;
    const meta = parsed[0] as Extract<CoordinationExportLine, { kind: 'meta' }>;
    if (!store.team()) store.ensureTeam(meta.teamName);
    for (const l of parsed) {
      if (l.kind === 'member' && !actor && !store.memberRow(l.id)) {
        store.createMember({ id: l.id, displayName: l.displayName, role: l.role, handles: l.handles });
        if (l.status === 'removed') store.stmt(`UPDATE coord_members SET status = 'removed' WHERE id = ?`).run(l.id);
      } else if (l.kind === 'claim') {
        claimOne(l);
      } else if (l.kind === 'endpoint') {
        createEndpoint(store, {
          id: l.id, slug: l.slug, projectKey: l.projectKey, name: l.name, source: l.source, handshake: l.handshake,
          ...(l.handshakeSecret ? { handshakeSecret: l.handshakeSecret } : {}), createdBy: actor?.memberId ?? null, createdAt: l.createdAt, disabledAt: l.disabledAt,
        });
        endpoints++;
      } else if (l.kind === 'message') {
        storeRequest(store, l.endpointId, {
          method: l.method, query: l.query, headers: l.headers, contentType: l.contentType, body: Buffer.from(l.bodyBase64, 'base64'),
        }, { receivedAt: l.receivedAt });
        messages++;
      }
    }
    return { claims, endpoints, messages };
  });
}
