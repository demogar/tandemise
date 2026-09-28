/**
 * A contribution handed in from outside a mission: a file the person
 * uploads, or a link to something that lives elsewhere (spec A1). It arrives
 * the same way whether it is an upload at creation, a feedback attachment or
 * a hand-back, so all three go through one pin-then-intake pipeline instead
 * of three bespoke ones.
 */

/** Decoded size cap for a file contribution: 24 MiB (spec A1). */
export const CONTRIBUTION_MAX_BYTES = 24 * 1024 * 1024;

/** What a link carries when no resolver on this machine can read the link itself. */
export interface ContributionExport {
  readonly filename: string;
  readonly mediaType: string;
  readonly dataBase64: string;
}

export type OutsideContribution =
  | { readonly kind: 'file'; readonly filename: string; readonly mediaType: string; readonly dataBase64: string }
  | { readonly kind: 'link'; readonly url: string; readonly label?: string; readonly export?: ContributionExport };

/**
 * The decoded size of a base64 payload, from its length alone. Enforcing the
 * 24 MB cap this way means refusing an oversized upload never costs the
 * memory of decoding it first: three encoded characters become at most four
 * bytes of base64, and each `=` pad character represents one byte fewer.
 */
export function decodedSize(dataBase64: string): number {
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  return Math.floor(dataBase64.length / 4) * 3 - padding;
}
