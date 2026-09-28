import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { EvalCandidateRequest, EvalRunView, EvalSuiteView, StartEvalRunRequest } from '@tandemise/api-contract';
import type { EvalCandidate, RoleTemplate, SkillRef } from '@tandemise/domain';
import { Icon } from '../../components/Icon.js';
import { Field, Segmented } from '../../components/primitives.js';
import { useEvalCases, useRoles, useSkills } from '../../lib/queries.js';
import { evalsHref } from './link.js';
import { Refusal, useEvalMutation } from './shared.js';

type Kind = EvalCandidate['kind'];

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: 'models', label: 'Models' },
  { value: 'skills', label: 'Skills' },
  { value: 'setup', label: 'Setup' },
];

/** A skill pin as the form edits it: a library version, or whatever is newest when the run starts. */
type Pin = SkillRef;

/**
 * Starts an eval run (spec B4): one suite, one change to try against the
 * setup the project has today, how many times to repeat each case, and a cap
 * on what the whole run may spend.
 *
 * A candidate from a link ("Try on evals") prefills the form; nothing is
 * applied to the project, the change exists only inside the run.
 */
export function RunForm({ suites, suiteId: initialSuiteId, candidate, onStarted, onCancel }: {
  suites: readonly EvalSuiteView[];
  suiteId: string | null;
  candidate: EvalCandidate | null;
  onStarted: (run: EvalRunView) => void;
  onCancel: () => void;
}): JSX.Element {
  const [suiteId, setSuiteId] = useState(initialSuiteId ?? suites[0]?.id ?? '');
  const [kind, setKind] = useState<Kind>(candidate?.kind ?? 'models');
  const [models, setModels] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Record<string, readonly Pin[]>>({});
  const [folder, setFolder] = useState(candidate?.kind === 'setup' ? candidate.folder : '');
  const [repeats, setRepeats] = useState('3');
  const [cap, setCap] = useState('5');
  const [problem, setProblem] = useState<string | null>(null);

  const cases = useEvalCases(suiteId === '' ? null : suiteId);
  const roles = useRoles();
  const library = useSkills();
  const start = useEvalMutation((daemon, body: StartEvalRunRequest) => daemon.startEvalRun(suiteId, body));

  // The roles the suite's cases run as, in the order they first appear: the only roles a candidate can change.
  const suiteRoles = useMemo(() => {
    const ids = [...new Set((cases.data ?? []).map((kase) => kase.roleId))];
    return ids.map((id) => roles.data?.find((r) => r.id === id) ?? null).filter((r): r is RoleTemplate => r !== null);
  }, [cases.data, roles.data]);

  if (suites.length === 0) {
    return (
      <div className="card stack" aria-label="New run" style={{ gap: 'var(--s2)' }}>
        <div className="field__label">New run</div>
        <p style={{ margin: 0 }}>
          Save a case first. A run replays a suite's cases, so it needs at least one:{' '}
          <Link href={evalsHref({ tab: 'suites' })}>go to Suites</Link>.
        </p>
        <div className="row">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Close</button>
        </div>
      </div>
    );
  }

  const modelFor = (role: RoleTemplate): string =>
    models[role.id] ?? (candidate?.kind === 'models' ? candidate.roles[role.id] : undefined) ?? role.models?.model ?? '';

  // The role's own pins, with a linked candidate's versions laid over them; an edit replaces the lot.
  const pinsFor = (role: RoleTemplate): readonly Pin[] => {
    const edited = skills[role.id];
    if (edited) return edited;
    const own: Pin[] = (role.skills ?? []).map((s) => ({ name: s.name, version: s.version }));
    const linked = candidate?.kind === 'skills' ? candidate.roles[role.id] ?? [] : [];
    for (const ref of linked) {
      const at = own.findIndex((p) => p.name === ref.name);
      if (at >= 0) own[at] = ref;
      else own.push(ref);
    }
    return own;
  };

  const setPin = (role: RoleTemplate, name: string, version: Pin['version']): void =>
    setSkills((current) => ({ ...current, [role.id]: pinsFor(role).map((p) => (p.name === name ? { name, version } : p)) }));

  const chooseFolder = async (): Promise<void> => {
    const path = await window.tandemise.selectDirectory('Choose a setup folder');
    if (path) setFolder(path);
  };

  const buildCandidate = (): EvalCandidateRequest | string => {
    if (kind === 'models') {
      const chosen = Object.fromEntries(suiteRoles.map((r) => [r.id, modelFor(r).trim()] as const).filter(([, model]) => model !== ''));
      return Object.keys(chosen).length === 0 ? 'Give at least one role a model to try.' : { kind, roles: chosen };
    }
    if (kind === 'skills') {
      const chosen = Object.fromEntries(suiteRoles.map((r): [string, SkillRef[]] => [r.id, [...pinsFor(r)]]).filter(([, pins]) => pins.length > 0));
      return Object.keys(chosen).length === 0 ? 'None of the roles this suite uses pin a skill.' : { kind, roles: chosen };
    }
    return folder === '' ? 'Choose a setup folder.' : { kind, folder };
  };

  const submit = (): void => {
    const built = buildCandidate();
    const count = Number(repeats);
    const dollars = Number(cap);
    const refusal = typeof built === 'string'
      ? built
      : !Number.isInteger(count) || count < 1 || count > 10
        ? 'Repeats must be a whole number from 1 to 10.'
        : !(dollars > 0)
          ? 'Set a spend cap above $0.'
          : null;
    setProblem(refusal);
    if (refusal !== null || typeof built === 'string') return;
    start.mutate({ candidate: built, repeats: count, spendCapUsd: dollars }, { onSuccess: onStarted });
  };

  return (
    <div className="card stack" aria-label="New run" style={{ gap: 'var(--s4)' }}>
      <div className="field__label">New run</div>
      <div className="grid grid--2">
        <Field label="Suite">
          <select className="select" aria-label="Suite" value={suiteId} onChange={(event) => { setSuiteId(event.target.value); setModels({}); setSkills({}); }}>
            {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name} ({suite.cases} {suite.cases === 1 ? 'case' : 'cases'})</option>)}
          </select>
        </Field>
        <Field label="Try">
          <div aria-label="Candidate kind">
            <Segmented value={kind} options={KINDS} onChange={setKind} block />
          </div>
        </Field>
      </div>

      {kind === 'setup' ? (
        <Field label="Setup folder" hint="A repository, or its .tandemise folder. Its roles are tried as they are there; nothing is applied to this project.">
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <span className={`mono truncate${folder === '' ? ' dim' : ''}`} style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)' }} title={folder}>
              {folder === '' ? 'No folder chosen' : folder}
            </span>
            <button type="button" className="btn" onClick={() => void chooseFolder()}>
              <Icon name="folder" size={13} />
              {folder === '' ? 'Choose…' : 'Change…'}
            </button>
          </div>
        </Field>
      ) : suiteRoles.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{cases.isPending || roles.isPending ? 'Reading the suite…' : 'This suite has no cases.'}</p>
      ) : (
        <table className="table" aria-label={kind === 'models' ? 'Models by role' : 'Skills by role'}>
          <thead>
            <tr><th style={{ width: '32%' }}>Role</th><th>{kind === 'models' ? 'Model to try' : 'Skill versions to try'}</th></tr>
          </thead>
          <tbody>
            {suiteRoles.map((role) => (
              <tr key={role.id} aria-label={role.name}>
                <td>
                  <div>{role.name}</div>
                  {kind === 'models' ? (
                    <div className="dim" style={{ fontSize: 'var(--fs-xs)' }}>Now: {role.models?.model ?? 'runtime default'}</div>
                  ) : null}
                </td>
                <td>
                  {kind === 'models' ? (
                    <input
                      className="input mono"
                      aria-label={`Model for ${role.name}`}
                      value={modelFor(role)}
                      placeholder="runtime default"
                      onChange={(event) => setModels((current) => ({ ...current, [role.id]: event.target.value }))}
                    />
                  ) : pinsFor(role).length === 0 ? (
                    <span className="dim">No skills pinned</span>
                  ) : (
                    <div className="stack" style={{ gap: 'var(--s2)' }}>
                      {pinsFor(role).map((pin) => {
                        const skill = library.data?.skills.find((s) => s.name === pin.name);
                        const pinned = role.skills?.find((s) => s.name === pin.name)?.version;
                        return (
                          <div key={pin.name} className="row" style={{ gap: 'var(--s2)' }}>
                            <span className="mono" style={{ flex: 1, minWidth: 0 }}>{pin.name}</span>
                            <select
                              className="select"
                              aria-label={`Version of ${pin.name} for ${role.name}`}
                              style={{ width: 200 }}
                              value={String(pin.version)}
                              onChange={(event) => setPin(role, pin.name, event.target.value === 'latest' ? 'latest' : Number(event.target.value))}
                            >
                              <option value="latest">latest{skill ? ` (v${skill.latest.version})` : ''}</option>
                              {(skill?.versions ?? []).map((v) => (
                                <option key={v.version} value={String(v.version)}>v{v.version}{v.version === pinned ? ' (pinned now)' : ''}</option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grid grid--2">
        <Field label="Repeats" hint="Each case runs this many times with the setup you have now, and as many with the change. 1 to 10.">
          <input className="input" aria-label="Repeats" type="number" min={1} max={10} step={1} value={repeats} onChange={(event) => setRepeats(event.target.value)} />
        </Field>
        <Field label="Spend cap ($)" hint="The run stops when its trials have spent this much.">
          <input className="input" aria-label="Spend cap" type="number" min={0.01} step={0.5} value={cap} onChange={(event) => setCap(event.target.value)} />
        </Field>
      </div>

      {problem ? <p className="field__error" role="alert" style={{ margin: 0 }}>{problem}</p> : null}
      {start.isError ? <Refusal error={start.error} /> : null}

      <div className="row" style={{ gap: 'var(--s2)' }}>
        <button type="button" className="btn btn--primary" disabled={start.isPending || suiteId === ''} onClick={submit}>
          <Icon name="play" size={13} />
          {start.isPending ? 'Starting…' : 'Start run'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
