import { Link, useLocation } from 'wouter';
import { Icon, type IconName } from './Icon.js';
import { Logo } from './Logo.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { useWorkspace } from '../lib/workspace.js';
import { useConnection } from '../lib/connection.js';
import type { StreamState } from '../lib/stream.js';
import type { Tone } from '../lib/format.js';

interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
}

const PRIMARY: readonly NavEntry[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/missions', label: 'Missions', icon: 'flag' },
  { href: '/inbox', label: 'Inbox', icon: 'approvals' },
  { href: '/artifacts', label: 'Artifacts', icon: 'artifacts' },
];

/**
 * Everything below here belongs to the selected project.
 *
 * Grouped under the project's own name rather than a generic "Configure",
 * because roles, runtimes and integrations are all project-scoped and the old
 * label made them read as machine-wide setup.
 */
const PROJECT: readonly NavEntry[] = [
  { href: '/project', label: 'Repositories', icon: 'folder' },
  { href: '/team', label: 'Team', icon: 'workforce' },
  { href: '/skills', label: 'Skills', icon: 'book' },
  { href: '/evals', label: 'Evals', icon: 'target' },
  { href: '/runtimes', label: 'Runtimes', icon: 'runtimes' },
  { href: '/integrations', label: 'Integrations', icon: 'integrations' },
];

/** The only genuinely install-wide screen. */
const APP: readonly NavEntry[] = [{ href: '/settings', label: 'Settings', icon: 'settings' }];

export function Sidebar({ pendingApprovals, stream }: { pendingApprovals: number; stream: StreamState }): JSX.Element {
  const [location] = useLocation();
  const { status, reconnect, reconnecting } = useConnection();
  const projectName = useWorkspace().current?.workspace.name ?? null;

  const connectionTone: Tone =
    status.phase !== 'connected' ? 'failed' : stream === 'open' ? 'succeeded' : stream === 'idle' ? 'pending' : 'blocked';
  const connectionLabel =
    status.phase !== 'connected'
      ? 'Daemon offline'
      : stream === 'open'
        ? 'Daemon connected'
        : stream === 'reconnecting'
          ? 'Reconnecting…'
          : 'Connecting…';

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">
          <Logo size={20} />
        </span>
        <span className="sidebar__name">Tandemise</span>
      </div>

      <WorkspaceSwitcher />

      <nav className="sidebar__nav">
        {PRIMARY.map((entry) => (
          <NavLink
            key={entry.href}
            entry={entry}
            active={isActive(location, entry.href)}
            count={entry.href === '/inbox' ? pendingApprovals : 0}
          />
        ))}
        <div className="sidebar__section truncate" title={projectName ?? undefined}>
          {projectName ?? 'Project'}
        </div>
        {PROJECT.map((entry) => (
          <NavLink key={entry.href} entry={entry} active={isActive(location, entry.href)} count={0} />
        ))}
        <div className="sidebar__section">App</div>
        {APP.map((entry) => (
          <NavLink key={entry.href} entry={entry} active={isActive(location, entry.href)} count={0} />
        ))}
      </nav>

      <div className="sidebar__footer">
        <button type="button" className="connection" onClick={reconnect} disabled={reconnecting} title={status.detail}>
          <span className={`dot dot--${connectionTone}${stream === 'open' ? ' dot--pulse' : ''}`} />
          <span className="connection__label">
            {reconnecting ? 'Reconnecting…' : connectionLabel}
            {status.phase === 'connected' && status.connection ? (
              <span className="connection__hint"> · {new URL(status.connection.url).port}</span>
            ) : null}
          </span>
          <Icon name="refresh" size={12} />
        </button>
      </div>
    </aside>
  );
}

function NavLink({ entry, active, count }: { entry: NavEntry; active: boolean; count: number }): JSX.Element {
  return (
    <Link href={entry.href} className="navitem" aria-current={active ? 'page' : undefined}>
      <Icon name={entry.icon} size={16} className="navitem__icon" />
      <span className="navitem__label">{entry.label}</span>
      {count > 0 ? <span className="navitem__count">{count}</span> : null}
    </Link>
  );
}

function isActive(location: string, href: string): boolean {
  return href === '/' ? location === '/' : location === href || location.startsWith(`${href}/`);
}
