import { useState } from 'react';
import { Route, Router, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { Sidebar } from './components/Sidebar.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { DaemonDown } from './screens/DaemonDown.js';
import { Home } from './screens/Home.js';
import { Missions } from './screens/Missions.js';
import { NewMission } from './screens/NewMission.js';
import { MissionDetail, type MissionTab } from './screens/mission/MissionDetail.js';
import { Approvals } from './screens/Approvals.js';
import { Artifacts } from './screens/Artifacts.js';
import { Workforce } from './screens/Workforce.js';
import { Runtimes } from './screens/Runtimes.js';
import { Integrations } from './screens/Integrations.js';
import { Settings } from './screens/Settings.js';
import { useConnection } from './lib/connection.js';
import { useDaemonStream } from './lib/stream.js';
import { useApprovals, useWorkspaces } from './lib/queries.js';
import { WorkspaceProvider } from './lib/workspace.js';
import { useHotkey } from './lib/keyboard.js';
import { useThemePreference } from './lib/theme.js';

export function App(): JSX.Element {
  // Hash routing: the production build is loaded from `file://`, where a path
  // router has no server to fall back to.
  return (
    <Router hook={useHashLocation}>
      <Shell />
    </Router>
  );
}

function Shell(): JSX.Element {
  const { status } = useConnection();
  useThemePreference();

  if (status.phase !== 'connected') return <DaemonDown />;
  return <ConnectedShell />;
}

/**
 * Split from `Shell` so every hook that needs a daemon client mounts only once
 * one exists - it removes the `client === null` branch from every screen.
 */
function ConnectedShell(): JSX.Element {
  // The workspace list is fetched above everything else because which project
  // is selected decides what every other query asks for. Fetching it inside the
  // shell would mean one render where each screen silently asks for "the whole
  // install" and then re-asks - visible as a flash of another project's data.
  const workspaces = useWorkspaces();
  return (
    <WorkspaceProvider workspaces={workspaces.data ?? []}>
      <ProjectShell />
    </WorkspaceProvider>
  );
}

function ProjectShell(): JSX.Element {
  const stream = useDaemonStream();
  const approvals = useApprovals();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [location, navigate] = useLocation();

  useHotkey('mod+k', () => setPaletteOpen((open) => !open));
  useHotkey('mod+n', () => navigate('/missions/new'));

  const pending = (approvals.data ?? []).filter((view) => view.approval.status === 'PENDING').length;

  return (
    <div className="app">
      <Sidebar pendingApprovals={pending} stream={stream} />
      <main className="main">
        {/* Per-route, and keyed by location: a screen that fails should not
            follow you to the next one, and navigating away is the most natural
            way to ask for a retry. */}
        <ErrorBoundary resetKey={location}>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/missions" component={Missions} />
            <Route path="/missions/new" component={NewMission} />
            <Route path="/missions/:id/:tab?">
              {(params) => <MissionDetail id={params.id ?? ''} tab={normalizeTab(params.tab)} />}
            </Route>
            <Route path="/approvals" component={Approvals} />
            <Route path="/artifacts" component={Artifacts} />
            <Route path="/workforce" component={Workforce} />
            <Route path="/runtimes" component={Runtimes} />
            <Route path="/integrations" component={Integrations} />
            <Route path="/settings" component={Settings} />
            <Route component={Home} />
          </Switch>
        </ErrorBoundary>
      </main>
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

const TABS: readonly MissionTab[] = ['plan', 'timeline', 'artifacts', 'checks', 'metrics'];

function normalizeTab(value: string | undefined): MissionTab {
  return TABS.includes(value as MissionTab) ? (value as MissionTab) : 'plan';
}
