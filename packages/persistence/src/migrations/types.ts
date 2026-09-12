/**
 * One ordered, immutable schema change.
 *
 * `up` is raw SQL rather than a callback because a migration must be readable
 * as a diff five years from now, and because a migration that can call
 * application code will eventually call application code that has since
 * changed. Data migrations that genuinely need logic get a dedicated
 * `transform` step when the first one appears - not before.
 */
export interface Migration {
  /** Strictly increasing, gapless from 1. Never renumbered once released. */
  readonly version: number;
  /** Short snake_case identifier, recorded alongside the version. */
  readonly name: string;
  readonly up: string;
}
