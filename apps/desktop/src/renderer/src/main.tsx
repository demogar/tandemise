import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { ConnectionProvider } from './lib/connection.js';
import { DaemonError } from './lib/daemon.js';
import './styles/theme.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/controls.css';
import './styles/surfaces.css';
import './styles/features.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The websocket drives freshness; polling on top of it would be noise.
      refetchOnWindowFocus: false,
      staleTime: 5_000,
      retry: (failureCount, error) => {
        // A 4xx from the daemon is an answer, not a hiccup - retrying it only
        // delays the error the user needs to see.
        if (error instanceof DaemonError && error.httpStatus < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Renderer root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
