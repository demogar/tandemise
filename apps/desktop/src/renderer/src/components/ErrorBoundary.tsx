import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './Icon.js';

/**
 * Keeps one screen's failure from taking the window with it.
 *
 * React unmounts the entire tree when a render throws, and in a desktop app
 * that is not an error message - it is a white window with no way back, which
 * reads as a crash. That is a real risk here because the renderer draws data
 * from a daemon it does not always share a build with: `npm run dev` reuses an
 * already-running daemon, so a new screen routinely meets an older response
 * shape, and one missing field would otherwise cost the whole app.
 *
 * Recovery is deliberately a reset of this boundary rather than a page reload:
 * the daemon connection, the event stream and every other screen are still
 * fine, and throwing them away to recover from one bad render would be a worse
 * outcome than the bug.
 */
interface Props {
  readonly children: ReactNode;
  /** Changing this resets the boundary - navigating away should clear an error. */
  readonly resetKey?: string;
}

interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only record of this: a renderer exception never reaches
    // the daemon's log.
    console.error('screen crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="page">
        <div className="page__inner">
          <div className="card">
            <div className="empty">
              <div className="empty__icon">
                <Icon name="alertCircle" size={22} />
              </div>
              <h2 className="empty__title">This screen stopped working</h2>
              <p className="empty__body">
                The rest of Tandemise is still running, and nothing in flight was interrupted. If this screen keeps failing after a retry,
                the daemon is probably older than the app — quit and run <code className="mono">npm run dev</code> again so both restart
                together.
              </p>
              <pre className="mono error-detail">{error.message}</pre>
              <button type="button" className="btn btn--primary" onClick={() => this.setState({ error: null })}>
                <Icon name="refresh" size={14} />
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
