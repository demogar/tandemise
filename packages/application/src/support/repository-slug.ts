/**
 * `owner/name` for a GitHub remote, or null for anything else.
 *
 * Accepts the forms `git remote get-url` returns: `git@github.com:o/n.git`,
 * `ssh://git@github.com/o/n.git`, `https://github.com/o/n(.git)`.
 */
export function githubSlug(remoteUrl: string | null): string | null {
  if (remoteUrl === null) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}
