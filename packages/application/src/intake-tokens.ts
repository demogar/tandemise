import { token } from '@tandemise/kernel';
import type { IntakeRepositoryPort, TrackerItemRepositoryPort, WebhookMailboxPort } from '@tandemise/domain';

/**
 * Intake's application tokens (spec 2026-10-30-intake-design.md). They live
 * here rather than in `tokens.ts` so intake adds no lines to a file other
 * features edit at the same time (plan Global Constraints).
 *
 * The repository tokens carry the same export names as their
 * `@tandemise/persistence` counterparts, which is how the daemon's
 * `aliasPorts` binds them to the SQLite implementations.
 */
export const INTAKE_REPOSITORY = token<IntakeRepositoryPort>('port.IntakeRepository');
export const TRACKER_ITEM_REPOSITORY = token<TrackerItemRepositoryPort>('port.TrackerItemRepository');
export const WEBHOOK_MAILBOX = token<WebhookMailboxPort>('port.WebhookMailbox');
