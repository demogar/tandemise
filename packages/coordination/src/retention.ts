import type { CoordinationStore } from './store.js';
import { enforceCaps, type RetentionPolicy } from './mailbox.js';

/**
 * The mailbox sweep (spec §The webhook mailbox, "Retention"): acked rows go
 * after `ackedRowMs`, unacked messages after `unackedMs` (counted on their
 * endpoint as dropped), and the caps are enforced again.
 */
export function sweep(store: CoordinationStore, policy: RetentionPolicy, now: Date = store.clock()): { deletedAcked: number; expiredUnacked: number } {
  return store.tx(() => {
    const ackedBefore = new Date(now.getTime() - policy.ackedRowMs).toISOString();
    const unackedBefore = new Date(now.getTime() - policy.unackedMs).toISOString();
    const deletedAcked = store.stmt(`DELETE FROM coord_mailbox WHERE acked_at IS NOT NULL AND acked_at < ?`).run(ackedBefore).changes;
    const expired = store.stmt(`SELECT endpoint_id, COUNT(*) AS n FROM coord_mailbox WHERE acked_at IS NULL AND received_at < ? GROUP BY endpoint_id`).all(unackedBefore) as { endpoint_id: string; n: number }[];
    for (const e of expired) {
      store.stmt(`UPDATE coord_endpoints SET dropped_count = dropped_count + ?, drop_flag = 1 WHERE id = ?`).run(e.n, e.endpoint_id);
    }
    const expiredUnacked = store.stmt(`DELETE FROM coord_mailbox WHERE acked_at IS NULL AND received_at < ?`).run(unackedBefore).changes;
    enforceCaps(store, policy);
    return { deletedAcked, expiredUnacked };
  });
}
