/**
 * The process-spawning seam.
 *
 * `desktop-control` never imports `node:child_process`. Not because the boundary
 * checker forbids it here - it does not, this is a provider package - but
 * because the client is then testable against a fake process with no binary, no
 * macOS and no permissions, and the daemon keeps a single place where processes
 * are actually created. The shape is deliberately the subset of Node's
 * `ChildProcess` the client uses, so the composition root can pass
 * `(cmd, args) => spawn(cmd, args)` with no adapter.
 */
export interface HelperReadable {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  setEncoding?(encoding: string): unknown;
}

export interface HelperWritable {
  write(chunk: string): unknown;
  end(): unknown;
}

export interface HelperProcess {
  readonly pid: number | undefined;
  readonly stdin: HelperWritable | null;
  readonly stdout: HelperReadable | null;
  readonly stderr: HelperReadable | null;
  kill(signal?: string): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnHelper = (command: string, args: readonly string[]) => HelperProcess;

/**
 * Splits a stream of bytes into the protocol's newline-delimited records.
 *
 * A chunk boundary has nothing to do with a message boundary, and a screenshot
 * response is megabytes of base64 that will certainly arrive in pieces.
 */
export class LineAssembler {
  #buffer = '';

  push(chunk: string | Uint8Array): readonly string[] {
    this.#buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const parts = this.#buffer.split('\n');
    // The trailing element is whatever follows the last newline: an incomplete
    // record, or '' when the chunk ended cleanly.
    this.#buffer = parts.pop() ?? '';
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** Anything left when the stream ends, for diagnostics. */
  flush(): string {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest;
  }
}
