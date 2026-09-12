import { StringDecoder } from 'node:string_decoder';

/**
 * Splits a byte stream into lines without imposing a maximum line length.
 *
 * Agent runtimes emit single-line JSON events that routinely exceed a megabyte,
 * so anything that caps or truncates a line corrupts the protocol. Multi-byte
 * characters are decoded across chunk boundaries by `StringDecoder`.
 */
export class LineSplitter {
  readonly #decoder = new StringDecoder('utf8');
  #rest = '';

  push(chunk: Buffer, emit: (line: string) => void): void {
    const parts = (this.#rest + this.#decoder.write(chunk)).split('\n');
    this.#rest = parts.pop() ?? '';
    for (const part of parts) emit(stripCr(part));
  }

  /** Flushes the trailing partial line, if the process ended without a newline. */
  end(emit: (line: string) => void): void {
    const tail = this.#rest + this.#decoder.end();
    this.#rest = '';
    if (tail.length > 0) emit(stripCr(tail));
  }
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/**
 * Single-consumer async queue. Producers never block: a slow reader grows the
 * buffer rather than stalling the child's pipe, which is the "capture without
 * blocking" requirement in MVP.md §21.1.
 */
export class LineQueue implements AsyncIterable<string> {
  readonly #buffered: string[] = [];
  readonly #waiting: Array<(r: IteratorResult<string>) => void> = [];
  #closed = false;

  push(line: string): void {
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.#buffered.push(line);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const buffered = this.#buffered.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<string>>((res) => this.#waiting.push(res));
      if (next.done) return;
      yield next.value;
    }
  }
}
