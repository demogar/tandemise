import { token } from '@tandemise/kernel';
import type {
  EvalBlobPort, IntakeClaimsPort, IntakeConfigSource, IntakeRepositoryPort, IntakeSimilarity, TrackerItemRepositoryPort,
  WebhookMailboxPort,
} from '@tandemise/domain';
import type { IntakeService } from './services/intake-service.js';
import type { TrackerService } from './services/tracker-service.js';
import type { TrackerResolver } from './intake/tracker-resolver.js';
import type { IntakeRunnerHost } from './intake/runner-host.js';
import type { ClosureService } from './services/closure-service.js';

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
/** Ranks dedupe's candidates (spec §5 step 4): lexical by default, a model-backed judge later (plan Task 7). */
export const INTAKE_SIMILARITY = token<IntakeSimilarity>('port.IntakeSimilarity');
/** Who works on what across daemons (plan Global Constraints): always granted locally; the relay (#54) rebinds it. */
export const INTAKE_CLAIMS = token<IntakeClaimsPort>('port.IntakeClaims');
/** The board from the primary tracker, and Start (plan Task 8). */
export const TRACKER_SERVICE = token<TrackerService>('application.TrackerService');
/** Drives the shipped intake runners and "Check sources now" (plan Task 10). */
export const INTAKE_RUNNER_HOST = token<IntakeRunnerHost>('application.IntakeRunnerHost');
/** Closes the loop at each source when the tracker item is done (plan Task 13). */
export const CLOSURE_SERVICE = token<ClosureService>('application.ClosureService');
