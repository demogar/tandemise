/**
 * Removes a leading YAML front-matter block from a Markdown document, for
 * display.
 *
 * This file has no imports on purpose: the desktop renderer is a sandboxed
 * browser context, and every `@tandemise/*` package entry reaches Node
 * built-ins. `scripts/check-boundaries.mjs` allowlists this module's subpath
 * only while it stays import-free, so the reader and the daemon share one rule
 * instead of a mirrored copy.
 *
 * Only a block that starts on the very first line and has a closing fence is
 * removed. A later `---` is a Markdown horizontal rule and is left alone, and
 * an unclosed fence is returned unchanged, because guessing where it ends would
 * hide real content.
 */
export function stripFrontMatter(markdown: string): string {
  const source = markdown.startsWith('﻿') ? markdown.slice(1) : markdown;
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (opening === null) return markdown;
  const closing = /^---[ \t]*(?:\r?\n|$)/m;
  const rest = source.slice(opening[0].length);
  const match = closing.exec(rest);
  if (match === null) return markdown;
  // Blank lines between the closing fence and the body are part of the header's spacing, not the body.
  return rest.slice(match.index + match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
}
