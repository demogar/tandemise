import { token } from '@tandemise/kernel';
import type {
  EvalBlobPort, IntakeConfigSource, IntakeRepositoryPort, TrackerItemRepositoryPort, WebhookMailboxPort,
} from '@tandemise/domain';
import type { IntakeService } from './services/intake-service.js';
import type { TrackerResolver } from './intake/tracker-resolver.js';

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

/** Where a project's intake configuration is read (plan Task 3): local settings by default, the brain (#51) later. */
export const INTAKE_CONFIG_SOURCE = token<IntakeConfigSource>('port.IntakeConfigSource');
export const INTAKE_SERVICE = token<IntakeService>('application.IntakeService');
/** Inline attachments of signals, content-addressed. In memory by default; the daemon rebinds it to disk. */
export const INTAKE_BLOBS = token<EvalBlobPort>('port.IntakeBlobs');
/** A project's primary tracker, built from its config and its credential (plan Task 5). */
export const TRACKER_RESOLVER = token<TrackerResolver>('application.TrackerResolver');
