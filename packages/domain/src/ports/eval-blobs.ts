/** Content-addressed bytes for eval case inputs, so a case outlives its mission and the artifact store. */
export interface EvalBlobPort {
  /** Stores the bytes and returns their sha256 hex. Storing the same bytes twice is a no-op. */
  put(bytes: Uint8Array): Promise<string>;
  /** Null when missing or when the stored bytes no longer hash to `sha256`. */
  get(sha256: string): Promise<Uint8Array | null>;
  has(sha256: string): Promise<boolean>;
}
