/**
 * Running this process's own Node again, as a child.
 *
 * A packaged desktop app runs the daemon on Electron's binary with
 * `ELECTRON_RUN_AS_NODE=1`. The daemon drops that variable from its own
 * environment at startup (see `forgetElectronRunAsNode`), so the shells,
 * agents and tools it starts never inherit it - an Electron app launched from
 * a held terminal would otherwise come up as a bare Node and do nothing.
 *
 * Where the daemon starts `process.execPath` itself (the MCP server it
 * publishes to an agent, the fake runtime's interactive session), it must
 * therefore ask for Node mode explicitly. Plain Node has no `electron`
 * version and ignores the variable, so this is empty in a checkout.
 */
export function ownNodeEnv(): Readonly<Record<string, string>> {
  return process.versions['electron'] === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' };
}

/** Called once by the daemon's entry point; see `ownNodeEnv`. */
export function forgetElectronRunAsNode(): void {
  if (process.versions['electron'] !== undefined) delete process.env['ELECTRON_RUN_AS_NODE'];
}
