/**
 * Who a piece of work belongs to. Carried into git authorship and commit
 * trailers so that history stays attributable to a role and a run rather than
 * to an anonymous "bot" (MVP.md §P7).
 */
export interface WorkAttribution {
  readonly name: string;
  readonly email: string;
  readonly roleId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly runtime?: string;
}
