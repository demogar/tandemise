import { TandemiseError } from '@tandemise/shared';

/**
 * Reassembles newline-delimited records from arbitrarily chunked stream data.
 *
 * The obvious `chunk.toString().split('\n')` is wrong twice: a chunk boundary
 * falls mid-line often enough to corrupt an NDJSON stream in practice, and a
 * fixed read buffer truncates. A single Claude Code `stream-json` line carrying
 * a large tool result comfortably exceeds 1 MB, so the carry-over is a growing
 * string with an explicit ceiling rather than a fixed allocation.
 */
export class LineAssembler {
  #carry = '';

  constructor(private readonly maxLineChars = 32 * 1024 * 1024) {}

  /** Returns the complete lines contained in `chunk`, retaining any remainder. */
  push(chunk: string): string[] {
    const combined = this.#carry + chunk;
    const parts = combined.split('\n');
    // `split` always yields at least one element; the last is the partial line.
    this.#carry = parts.pop() ?? '';
    if (this.#carry.length > this.maxLineChars) {
      const length = this.#carry.length;
      this.#carry = '';
      throw new TandemiseError('RUNTIME_FAILED', `Runtime emitted a single line over ${this.maxLineChars} chars`, {
        details: { length },
      });
    }
    return parts.map(stripCarriageReturn).filter((l) => l.length > 0);
  }

  /** The trailing line a process may leave without a final newline. */
  flush(): string | null {
    const rest = stripCarriageReturn(this.#carry);
    this.#carry = '';
    return rest.length > 0 ? rest : null;
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
