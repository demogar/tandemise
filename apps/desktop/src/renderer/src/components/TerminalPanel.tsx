import { useEffect, useRef, useState } from 'react';
import type { MissionDetail, TaskView } from '@tandemise/api-contract';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';
import { Icon } from './Icon.js';
import { ApprovalCard } from '../screens/approvals/ApprovalCard.js';
import { useDaemon } from '../lib/connection.js';
import { describeError } from '../lib/daemon.js';
import { useDaemonMutation } from '../lib/queries.js';
import { closeTerminal, openTerminal } from '../lib/terminal.js';
import { useActors } from '../lib/team.js';

/** What a hold changes on the mission: the step's status, the run it stopped, the requests it withdrew. */
const HOLD_TOPICS = ['tasks', 'missions', 'approvals'] as const;

/** How long a panel waits for the mission view to show a hold it was opened for, before closing as stale. */
const STALE_VIEW_GRACE_MS = 5000;

/**
 * A held step's terminal, over the whole mission screen.
 *
 * It is a window onto the daemon's terminal, nothing more: keystrokes go out
 * on the task's terminal socket and its output comes back on it. Closing the
 * panel leaves the hold and its session running; Continue and Release are the
 * two ways to end it, and both are the daemon's to decide.
 */
export function TerminalPanel({ task, detail }: { task: TaskView; detail: MissionDetail }): JSX.Element {
  const missionId = detail.mission.id;
  const actors = useActors();
  const { cont, release } = useHoldActions(task.id, missionId);
  const reopen = useDaemonMutation((daemon) => daemon.reopenTerminal(task.id), HOLD_TOPICS, missionId);
  // Bumped to attach a fresh socket after the terminal was opened again.
  const [attachment, setAttachment] = useState(0);
  const [ended, setEnded] = useState<string | null>(null);
  const hold = task.hold;

  // The hold ended (here, in another window, or by someone else): there is no terminal left to show.
  // Right after Hold the mission view on screen may not have caught up yet, so a hold never seen gets a few seconds.
  const seenHold = useRef(false);
  useEffect(() => {
    if (hold !== null) {
      seenHold.current = true;
      return undefined;
    }
    const timer = setTimeout(closeTerminal, seenHold.current ? 0 : STALE_VIEW_GRACE_MS);
    return () => clearTimeout(timer);
  }, [hold]);

  // While a hold is open, a tool whose policy is "ask" still asks; the question is shown here so it is not missed.
  const asking = detail.approvals.filter((a) => a.taskId === task.id && a.status === 'PENDING' && a.kind !== 'check');
  const heldBy = hold === null ? null : hold.heldBy === actors.meId ? 'You' : hold.heldByName;
  const failure = cont.error ?? release.error ?? reopen.error;

  return (
    <div className="overlay terminal-overlay">
      <section className="terminal-panel" role="dialog" aria-modal="true" aria-label={`Terminal: ${task.title}`}>
        <header className="terminal-panel__head">
          <Icon name="terminal" size={15} className="terminal-panel__icon" />
          <div className="terminal-panel__titles">
            <h2 className="terminal-panel__title truncate" title={task.title}>{task.title}</h2>
            {heldBy !== null ? <span className="terminal-panel__holder">Held by {heldBy}</span> : null}
          </div>
          <div className="terminal-panel__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={cont.isPending || release.isPending || hold === null}
              title="End your hold and let the agent finish the step from where you left it"
              onClick={() => cont.mutate(undefined)}
            >
              <Icon name="play" size={13} />
              {cont.isPending ? 'Continuing…' : 'Continue'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={cont.isPending || release.isPending || hold === null}
              title="End your hold without asking the agent to continue; the step goes back to the queue"
              onClick={() => release.mutate(undefined)}
            >
              {release.isPending ? 'Releasing…' : 'Release'}
            </button>
            <button type="button" className="btn btn--ghost" title="The session keeps running; open it again from the step" onClick={closeTerminal}>
              <Icon name="x" size={13} />
              Close terminal
            </button>
          </div>
        </header>

        {failure ? <p className="terminal-panel__error field__error" role="alert">{describeError(failure).detail}</p> : null}

        {asking.length > 0 ? (
          <div className="terminal-panel__asking" aria-label="Waiting for your decision">
            {asking.map((approval) => (
              <ApprovalCard
                key={approval.id}
                compact
                view={{
                  approval, missionTitle: null, taskTitle: null, roleName: task.roleName, revisable: false,
                  addressees: [], decidedByRef: null, recordedByRef: null, escalationLevel: approval.escalationLevel ?? 0, headline: null,
                }}
              />
            ))}
          </div>
        ) : null}

        <div className="terminal-panel__body" data-ended={ended !== null}>
          <TerminalView key={attachment} taskId={task.id} onEnded={setEnded} />
          {ended !== null ? (
            <div className="terminal-panel__ended" role="status">
              <div className="terminal-panel__ended-words">
                <p className="terminal-panel__ended-text">The session ended.</p>
                {/* The daemon's own words, when it said more than that (no terminal after a restart, say). */}
                {ended !== '' ? <p className="terminal-panel__ended-detail">{ended}</p> : null}
              </div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={reopen.isPending || hold === null}
                onClick={() => reopen.mutate(undefined, {
                  onSuccess: () => {
                    setEnded(null);
                    setAttachment((n) => n + 1);
                  },
                })}
              >
                <Icon name="refresh" size={13} />
                {reopen.isPending ? 'Opening…' : 'Open the terminal again'}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * The xterm.js surface and its socket, for one attachment. The daemon repaints
 * the scrollback on attach, so a new attachment starts from a blank screen.
 */
/** `onEnded` gets the daemon's reason when it gave one, and '' when the session simply ended. */
function TerminalView({ taskId, onEnded }: { taskId: string; onEnded: (message: string) => void }): JSX.Element {
  // Keyed by the address, not the client object: the client is rebuilt on unrelated status changes.
  const url = useDaemon().terminalUrl(taskId);
  const host = useRef<HTMLDivElement>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(element).fontFamily,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(element),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();
    let over = false;
    const finish = (message: string): void => {
      if (over) return;
      over = true;
      ended.current(message);
    };
    const sendSize = (): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const refit = (): void => {
      // A panel still laying out measures as zero, and xterm would shrink to one column.
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
    };

    socket.onopen = () => {
      refit();
      sendSize();
      term.focus();
    };
    socket.onmessage = (frame) => {
      if (frame.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(frame.data));
        return;
      }
      const control = parseControl(frame.data);
      if (control?.type === 'exit') finish('');
      else if (control?.type === 'error') finish(control.message);
    };
    // A socket that drops without saying why: the daemon restarted, or went away. Either way the session is gone.
    socket.onclose = () => finish('');

    const typed = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const resized = term.onResize(sendSize);
    const observer = new ResizeObserver(refit);
    observer.observe(element);

    // The theme follows the app's: an explicit choice stamps data-theme, "system" follows the OS.
    const retheme = (): void => { term.options.theme = terminalTheme(element); };
    const stamps = new MutationObserver(retheme);
    stamps.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', retheme);

    return () => {
      over = true;
      scheme.removeEventListener('change', retheme);
      stamps.disconnect();
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      socket.onclose = null;
      socket.close();
      term.dispose();
    };
  }, [url]);

  return <div ref={host} className="terminal-panel__xterm" />;
}

/**
 * "Hold" for a step that can be held, "Open terminal" for one that is held,
 * and a disabled Hold with the daemon's reason for one that cannot. The view's
 * answer is a forecast: the daemon may still refuse, and then its words show.
 */
export function HoldButton({ task, missionId, className = 'btn', onOpen }: {
  task: TaskView;
  missionId: string;
  className?: string;
  /** Called once the terminal is to be shown, so a drawer can step out of its way. */
  onOpen?: () => void;
}): JSX.Element {
  const hold = useDaemonMutation((daemon) => daemon.holdTask(task.id), HOLD_TOPICS, missionId);
  const show = (): void => {
    openTerminal(task.id);
    onOpen?.();
  };
  if (task.hold !== null) {
    return (
      <button type="button" className={className} onClick={show}>
        <Icon name="terminal" size={13} />
        Open terminal
      </button>
    );
  }
  const reason = task.holdable.ok ? 'Stop the agent and work with it in its own terminal' : task.holdable.reason;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={!task.holdable.ok || hold.isPending}
        title={reason}
        onClick={() => hold.mutate(undefined, { onSuccess: show })}
      >
        <Icon name="pause" size={13} />
        {hold.isPending ? 'Holding…' : 'Hold'}
      </button>
      {hold.isError ? <span className="field__error hold-refusal" role="alert">{describeError(hold.error).detail}</span> : null}
    </>
  );
}

/** Continue and Release, wherever a held step offers them. */
export function useHoldActions(taskId: string, missionId: string) {
  const cont = useDaemonMutation((daemon) => daemon.continueTask(taskId), HOLD_TOPICS, missionId);
  const release = useDaemonMutation((daemon) => daemon.releaseTask(taskId), HOLD_TOPICS, missionId);
  return { cont, release };
}

/** "Now: Editing src/app/page.tsx" for a live agent step; nothing otherwise. */
export function NowLine({ now, className = '' }: { now: string | null; className?: string }): JSX.Element | null {
  if (now === null) return null;
  return (
    <p className={`now-line ${className}`.trim()} aria-label="Now" title={now}>
      <span className="now-line__label">Now</span>
      <span className="now-line__text truncate">{now}</span>
    </p>
  );
}

type Control = { type: 'exit'; code: number | null } | { type: 'error'; message: string };

function parseControl(data: unknown): Control | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as Control;
    return value.type === 'exit' || value.type === 'error' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The terminal roles from theme.css, resolved to the colours the current theme
 * gives them. A custom property reads back as the `light-dark()` text it was
 * written with, so each role is set on a probe's `color` and read from there.
 */
function terminalTheme(element: HTMLElement): ITheme {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  element.appendChild(probe);
  const resolve = (role: string): string => {
    probe.style.color = `var(${role})`;
    return getComputedStyle(probe).color;
  };
  const red = resolve('--status-failed');
  const green = resolve('--status-succeeded');
  const yellow = resolve('--status-blocked');
  const blue = resolve('--status-running');
  const magenta = resolve('--risk-release');
  const theme: ITheme = {
    background: resolve('--terminal-background'),
    foreground: resolve('--terminal-foreground'),
    cursor: resolve('--terminal-cursor'),
    cursorAccent: resolve('--terminal-background'),
    selectionBackground: resolve('--terminal-selection'),
    red, green, yellow, blue, magenta,
    brightRed: red, brightGreen: green, brightYellow: yellow, brightBlue: blue, brightMagenta: magenta,
  };
  probe.remove();
  return theme;
}
