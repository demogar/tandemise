import { useState } from 'react';
import { Redirect, Route, Router, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { Sidebar } from './components/Sidebar.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { DaemonDown } from './screens/DaemonDown.js';
import { FirstProject } from './screens/FirstProject.js';
import { Home } from './screens/Home.js';
import { Missions } from './screens/Missions.js';
import { NewMission } from './screens/NewMission.js';
import { MISSION_TABS, MissionDetail, type MissionTab } from './screens/mission/MissionDetail.js';
import { Inbox } from './screens/Inbox.js';
import { Artifacts } from './screens/Artifacts.js';
import { Team, type TeamTab } from './screens/team/Team.js';
import { Runtimes } from './screens/Runtimes.js';
import { Integrations } from './screens/Integrations.js';
import { Settings } from './screens/Settings.js';
import { Project } from './screens/Project.js';
import { useConnection } from './lib/connection.js';
import { useDaemonStream } from './lib/stream.js';
import { useWorkspaces } from './lib/queries.js';
import { useInbox } from './lib/inbox.js';
import { useNotificationOpen } from './lib/notifications.js';
import { WorkspaceProvider } from './lib/workspace.js';
import { useHotkey } from './lib/keyboard.js';
import { useThemePreference } from './lib/theme.js';
import { useFlash } from './lib/notices.js';
import { ImpactHost } from './components/ImpactDialog.js';
import { ComposerHost } from './components/RequestChanges.js';

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

  // Nothing until the list is known: rendering the shell first and the first-run
  // screen a moment later reads as the app changing its mind.
  if (workspaces.isPending) return <div className="app app--booting" />;

  // A project is made deliberately. The daemon no longer seeds one, so an empty
  // install has exactly one thing to do.
  if ((workspaces.data ?? []).length === 0) return <FirstProject />;

  return (
    <WorkspaceProvider workspaces={workspaces.data ?? []}>
      <ProjectShell />
    </WorkspaceProvider>
  );
}

/** The one-line result of an action whose effect lands somewhere else on screen; announced, never focused. */
function Flash(): JSX.Element | null {
  const text = useFlash();
  return text === null ? null : (
    <div className="flash" role="status">
      {text}
    </div>
  );
}

function ProjectShell(): JSX.Element {
  const stream = useDaemonStream();
  const inbox = useInbox();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [location, navigate] = useLocation();

  useHotkey('mod+k', () => setPaletteOpen((open) => !open));
  useHotkey('mod+n', () => navigate('/missions/new'));
  useNotificationOpen();

  // Approvals addressed to me plus human tasks I can pick up: what is actually mine to do.
  const pending = inbox.forMeCount;

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
            <Route path="/missions">{() => <Missions />}</Route>
            <Route path="/missions/new" component={NewMission} />
            {/* Home's desk opens the list behind each number (P10). */}
            <Route path="/missions/backlog">{() => <Missions initial="backlog" />}</Route>
            <Route path="/missions/routines">{() => <Missions initial="routines" />}</Route>
            <Route path="/missions/in-progress">{() => <Missions initial="progress" />}</Route>
            <Route path="/missions/:id/:tab?">
              {(params) => <MissionDetail id={params.id ?? ''} tab={normalizeTab(params.tab)} />}
            </Route>
            <Route path="/inbox">{() => <Inbox />}</Route>
            <Route path="/inbox/stalled">{() => <Inbox only="stalled" />}</Route>
            <Route path="/approvals">
              <Redirect to="/inbox" replace />
            </Route>
            <Route path="/artifacts">{() => <Artifacts />}</Route>
            <Route path="/artifacts/:id">{(params) => <Artifacts openId={params.id ?? null} />}</Route>
            <Route path="/team/:tab?">{(params) => <Team tab={normalizeTeamTab(params.tab)} />}</Route>
            <Route path="/workforce">
              <Redirect to="/team" replace />
            </Route>
            <Route path="/runtimes" component={Runtimes} />
            <Route path="/integrations" component={Integrations} />
            <Route path="/project" component={Project} />
            <Route path="/settings" component={Settings} />
            <Route component={Home} />
          </Switch>
        </ErrorBoundary>
      </main>
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      <Flash />
      <ComposerHost />
      <ImpactHost />
    </div>
  );
}

/** A mission opens on its feed; an unknown tab does too, rather than on an empty pane. */
function normalizeTab(value: string | undefined): MissionTab {
  return (MISSION_TABS as readonly string[]).includes(value ?? '') ? (value as MissionTab) : 'feed';
}

const TEAM_TABS: readonly TeamTab[] = ['people', 'staffing', 'roles'];

function normalizeTeamTab(value: string | undefined): TeamTab {
  return TEAM_TABS.includes(value as TeamTab) ? (value as TeamTab) : 'people';
}
