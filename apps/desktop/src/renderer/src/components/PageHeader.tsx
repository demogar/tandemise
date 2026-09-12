import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Icon } from './Icon.js';

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  crumbs?: readonly Crumb[];
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar__titles">
        {crumbs && crumbs.length > 0 ? (
          <div className="topbar__eyebrow">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {index > 0 ? <Icon name="chevronRight" size={11} /> : null}
                {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
              </span>
            ))}
          </div>
        ) : null}
        <h1 className="topbar__title">{title}</h1>
        {subtitle ? <div className="topbar__subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="topbar__actions">{actions}</div> : null}
    </header>
  );
}
