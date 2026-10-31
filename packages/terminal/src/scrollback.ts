/**
 * A byte ring that keeps the newest `capacity` bytes of a terminal's output, so
 * a window opened later (or reopened) can be brought up to date by replaying it.
 */
export class Scrollback {
  readonly #capacity: number;
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(capacity = 1024 * 1024) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#size;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    // Drop whole old chunks first, then trim the front of the oldest one.
    while (this.#size > this.#capacity) {
      const over = this.#size - this.#capacity;
      const head = this.#chunks[0]!;
      if (head.length <= over) {
        this.#chunks.shift();
        this.#size -= head.length;
      } else {
        this.#chunks[0] = head.subarray(over);
        this.#size -= over;
      }
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}
