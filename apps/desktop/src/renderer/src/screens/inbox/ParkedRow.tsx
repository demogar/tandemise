import { Link } from 'wouter';
import type { InboxParkedView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { relativeTime } from '../../lib/format.js';

/**
 * A step taken to another tool, waiting for its hand-back (spec A4). The row
 * opens the mission, where the step's card has "Hand back"; nothing is decided
 * from the line itself, because what comes back is a file or a link to attach.
 */
export function ParkedRow({ parked, bordered = false }: { parked: InboxParkedView; bordered?: boolean }): JSX.Element {
  return (
    <Link
      href={parked.href}
      className={`list__row inbox__row${bordered ? ' list__row--bordered' : ''}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
      aria-label={`${parked.title}: ${parked.taskTitle}`}
    >
      <span className="dot dot--blocked" />
      <div className="list__main">
        <div className="list__title truncate">{parked.title}</div>
        <div className="list__subtitle truncate">
          {parked.taskTitle}
          <span className="sep">·</span>
          {parked.missionTitle}
        </div>
      </div>
      <div className="list__aside">
        <span className="chip chip--muted">Hand back</span>
        <span className="dim" style={{ fontSize: 'var(--fs-xs)', minWidth: 56, textAlign: 'right' }}>{relativeTime(parked.since)}</span>
        <Icon name="chevronRight" size={13} className="dim" />
      </div>
    </Link>
  );
}
