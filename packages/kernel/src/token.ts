/**
 * A typed service token.
 *
 * Tokens - not class references, not string keys - are how Tandemise names the
 * things it depends on. A consumer imports a token from a *contract* package and
 * never learns which concrete module satisfies it. That is the whole point:
 * `application` can ask for `MISSION_REPOSITORY` without any code path that
 * reaches SQLite, and `runtimes-core` can ask for adapters without knowing that
 * Claude Code exists.
 */
declare const typeMarker: unique symbol;

export interface Token<T> {
  readonly description: string;
  readonly [typeMarker]?: T;
}

export function token<T>(description: string): Token<T> {
  return Object.freeze({ description, toString: () => `Token(${description})` }) as Token<T>;
}

/** Multi-binding token: resolves to `readonly T[]` collected from all providers. */
export interface MultiToken<T> extends Token<readonly T[]> {
  readonly multi: true;
  readonly itemDescription: string;
}

export function multiToken<T>(description: string): MultiToken<T> {
  return Object.freeze({
    description: `${description}[]`,
    itemDescription: description,
    multi: true as const,
    toString: () => `MultiToken(${description})`,
  }) as MultiToken<T>;
}

export function isMultiToken(t: Token<unknown>): t is MultiToken<unknown> {
  return (t as { multi?: boolean }).multi === true;
}
