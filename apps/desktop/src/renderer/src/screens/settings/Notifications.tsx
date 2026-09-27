import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationPreferencesView, UpdateNotificationPreferencesRequest } from '@tandemise/api-contract';
import { ErrorState, SectionHead, Switch } from '../../components/primitives.js';
import { useDaemon } from '../../lib/connection.js';
import { showFlash } from '../../lib/notices.js';

type Kind = keyof NotificationPreferencesView['kinds'];

/** One switch per kind of Inbox item (P16 spec §1), in the order the Inbox reads. */
const KINDS: ReadonlyArray<{ kind: Kind; title: string; detail: string }> = [
  { kind: 'decisions', title: 'Decisions and approvals', detail: 'A plan, a card or a step waits on your answer.' },
  { kind: 'refinements', title: 'Refinements', detail: 'A draft has proposals or questions to decide before it can be planned.' },
  { kind: 'stalled', title: 'Stalled missions', detail: 'Nothing moves a mission and nothing asks you about it.' },
  { kind: 'quiet', title: 'Quiet agents', detail: 'An agent has printed nothing for longer than it should.' },
  { kind: 'limits', title: 'Limits', detail: 'A mission or the project stopped at a spend or time limit.' },
];

const DEFAULT_QUIET = { from: '22:00', to: '07:00' } as const;
const KEY = ['settings', 'notifications'] as const;

/**
 * Settings → Notifications (P16). The daemon keeps the preferences, so they
 * hold for a window re-opened from the tray and for the main process, which is
 * what actually shows the notifications.
 */
export function NotificationSettings(): JSX.Element {
  const daemon = useDaemon();
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: KEY, queryFn: () => daemon.notificationPreferences(), refetchInterval: 60_000 });
  const update = useMutation({
    mutationFn: (body: UpdateNotificationPreferencesRequest) => daemon.updateNotificationPreferences(body),
    onSuccess: (view) => queryClient.setQueryData(KEY, view),
  });
  const test = useMutation({
    mutationFn: () => window.tandemise.testNotification(),
    onSuccess: () => showFlash('Test notification sent.'),
  });

  const view = preferences.data;
  const quiet = view?.quietHours ?? null;
  const [from, setFrom] = useState<string>(quiet?.from ?? DEFAULT_QUIET.from);
  const [to, setTo] = useState<string>(quiet?.to ?? DEFAULT_QUIET.to);
  // Follow what was saved, so the inputs never show hours that are not in force.
  useEffect(() => {
    if (quiet !== null) {
      setFrom(quiet.from);
      setTo(quiet.to);
    }
  }, [quiet?.from, quiet?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = quiet !== null && (from !== quiet.from || to !== quiet.to);
  const sameEnds = from === to;

  return (
    <section className="section" aria-label="Notifications">
      <SectionHead title="Notifications" meta={view?.quietNow ? 'Quiet hours now' : undefined} />
      {preferences.isError ? <ErrorState error={preferences.error} onRetry={() => void preferences.refetch()} /> : null}
      <div className="card card--flush">
        {KINDS.map(({ kind, title, detail }) => (
          <div className="list__row" key={kind}>
            <div className="list__main">
              <div className="list__title">{title}</div>
              <div className="list__subtitle">{detail}</div>
            </div>
            <div className="list__aside">
              <Switch
                checked={view?.kinds[kind] ?? true}
                label={title}
                onChange={(on) => update.mutate({ kinds: { [kind]: on } })}
              />
            </div>
          </div>
        ))}

        <div className="list__row">
          <div className="list__main">
            <div className="list__title">Quiet hours</div>
            <div className="list__subtitle">
              {quiet === null
                ? 'Off. Turn on to hold notifications overnight; what arrives is summarised once in the morning.'
                : `${quiet.from} to ${quiet.to}. Held during these hours and summarised once they end.`}
            </div>
          </div>
          <div className="list__aside">
            <Switch
              checked={quiet !== null}
              label="Quiet hours"
              onChange={(on) => update.mutate({ quietHours: on ? { from, to: sameEnds ? DEFAULT_QUIET.to : to } : null })}
            />
          </div>
        </div>
        {quiet !== null ? (
          <div className="list__row">
            <div className="list__main">
              <div className="row">
                <input className="input" type="time" style={{ width: 120 }} aria-label="From" value={from} onChange={(event) => setFrom(event.target.value)} />
                <span className="list__subtitle">to</span>
                <input className="input" type="time" style={{ width: 120 }} aria-label="To" value={to} onChange={(event) => setTo(event.target.value)} />
              </div>
              {sameEnds ? <div className="field__error">Pick a different start and end.</div> : null}
            </div>
            <div className="list__aside">
              <button
                type="button"
                className="btn"
                disabled={!dirty || sameEnds || update.isPending}
                onClick={() => update.mutate({ quietHours: { from, to } })}
              >
                Save quiet hours
              </button>
            </div>
          </div>
        ) : null}

        <div className="list__row">
          <div className="list__main">
            <div className="list__title">Check they reach you</div>
            <div className="list__subtitle">
              Sends one notification now. If nothing appears, allow notifications for Tandemise in your system settings.
            </div>
          </div>
          <div className="list__aside">
            <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
              Send a test notification
            </button>
          </div>
        </div>
      </div>
      {update.isError ? <ErrorState error={update.error} /> : null}
    </section>
  );
}
