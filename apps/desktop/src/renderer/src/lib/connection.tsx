import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DaemonClient } from './daemon.js';
import type { DaemonStatus } from '../../../shared/bridge.js';

interface ConnectionValue {
  readonly status: DaemonStatus;
  /** Null until the daemon has reported a usable url + token. */
  readonly client: DaemonClient | null;
  reconnect(): void;
  readonly reconnecting: boolean;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

const INITIAL: DaemonStatus = {
  phase: 'connecting',
  connection: null,
  detail: 'Connecting to the Tandemise daemon…',
  handshakePath: '~/.tandemise/daemon.json',
  updatedAt: new Date(0).toISOString(),
};

export function ConnectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<DaemonStatus>(INITIAL);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    const bridge = window.tandemise;
    const unsubscribe = bridge.onDaemonStatus(setStatus);
    void bridge.getDaemonStatus().then(setStatus);
    return unsubscribe;
  }, []);

  const value = useMemo<ConnectionValue>(() => {
    // Rebuilding the client only when the token or url actually change keeps the
    // websocket from reconnecting on every unrelated status tick.
    const connection = status.connection;
    return {
      status,
      client: connection ? new DaemonClient(connection) : null,
      reconnecting,
      reconnect: () => {
        setReconnecting(true);
        void window.tandemise
          .reconnectDaemon()
          .then(setStatus)
          .finally(() => setReconnecting(false));
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.connection?.url, status.connection?.token, status.phase, status.detail, reconnecting]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('useConnection must be used inside <ConnectionProvider>');
  return value;
}

/**
 * The client, asserted present. Screens are only mounted once the daemon is
 * connected, so making them each handle `null` would be noise.
 */
export function useDaemon(): DaemonClient {
  const { client } = useConnection();
  if (!client) throw new Error('useDaemon used while the daemon is not connected');
  return client;
}
