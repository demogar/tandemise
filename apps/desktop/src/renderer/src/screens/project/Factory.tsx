import type { FactoryFileView, RoutingClassView } from '@tandemise/api-contract';
import { ErrorState, SectionHead, SkeletonList } from '../../components/primitives.js';
import { useDaemonMutation, useFactory, useRouting } from '../../lib/queries.js';
import { shortenPath } from '../../lib/format.js';
import './Factory.css';

/**
 * Project → Factory (#53 §10): where the planner, routing and merge files came
 * from, the rules in them that don't parse, writing the built-in files into the
 * repository, and the routing each step class gets. It lives here until the
 * brain's screen exists. Every sentence comes from the daemon.
 */
export function Factory({ workspaceId }: { workspaceId: string }): JSX.Element {
  const factory = useFactory();
  const routing = useRouting();
  const write = useDaemonMutation((daemon) => daemon.writeFactoryDefaults(workspaceId), ['workspaces']);
  const view = factory.data;

  return (
    <section className="section" aria-label="Factory">
      <SectionHead
        title="Factory"
        meta="How tasks are planned, which models they use, and when a pull request merges"
        action={
          view?.canWriteDefaults === true ? (
            <button type="button" className="btn" disabled={write.isPending} onClick={() => write.mutate(undefined)}>
              {write.isPending ? 'Writing…' : 'Write the defaults into the repository'}
            </button>
          ) : undefined
        }
      />
      {view === undefined ? (
        factory.isError ? <ErrorState error={factory.error} onRetry={() => void factory.refetch()} /> : <SkeletonList rows={3} />
      ) : (
        <div className="card card--flush">
          {view.files.map((file) => <FactoryFile key={file.name} file={file} />)}
        </div>
      )}
      {view?.canWriteDefaults === true && view.repositoryName !== null ? (
        <p className="factory__hint">Writing the defaults puts the built-in files into {view.repositoryName}, so you can edit them there.</p>
      ) : null}
      {write.isError ? <ErrorState error={write.error} /> : null}

      <div className="factory__routing" aria-label="Routing">
        <h3 className="factory__title">Routing</h3>
        {routing.data === undefined ? (
          routing.isError ? <ErrorState error={routing.error} onRetry={() => void routing.refetch()} /> : <SkeletonList rows={2} />
        ) : (
          <>
            <p className="factory__hint">{routing.data.ruleLine}</p>
            {routing.data.empty !== null ? <p className="factory__empty">{routing.data.empty}</p> : null}
            {routing.data.classes.map((cls) => <RoutingClass key={cls.stepClass} cls={cls} />)}
          </>
        )}
      </div>
    </section>
  );
}

function FactoryFile({ file }: { file: FactoryFileView }): JSX.Element {
  return (
    <div className="list__row factory__file" data-origin={file.origin} data-problems={file.problems.length > 0}>
      <div className="list__main">
        <div className="list__title">{file.title}</div>
        <div className="list__subtitle">
          {file.originLine}
          {file.path !== null ? <span className="mono factory__path" title={file.path}> · {shortenPath(file.path, 4)}</span> : null}
        </div>
        {file.problems.length > 0 ? (
          <ul className="factory__problems" aria-label={`Problems in ${file.title}`}>
            {file.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        ) : null}
      </div>
      <div className="list__aside">
        <span className="chip chip--muted mono" title="The version of the file that was read">{file.ref}</span>
      </div>
    </div>
  );
}

function RoutingClass({ cls }: { cls: RoutingClassView }): JSX.Element {
  return (
    <div className="factory__class" aria-label={`${cls.title} routing`}>
      <div className="factory__class-head">
        <strong>{cls.title}</strong> <span className="factory__muted">{cls.ladderLine}</span>
      </div>
      {cls.empty !== null ? <p className="factory__empty">{cls.empty}</p> : null}
      {cls.buckets.map((bucket) => (
        <div key={bucket.key} className="factory__bucket">
          <div className="factory__bucket-head">
            {bucket.title} <span className="factory__muted">{bucket.startingLine}</span>
          </div>
          <table className="table" aria-label={`${cls.title}, ${bucket.title}`}>
            <thead>
              <tr>
                <th>Model</th>
                <th className="factory__num">Steps</th>
                <th className="factory__num">Passed first time</th>
                <th className="factory__num">Succeeded</th>
                <th className="factory__num">Median cost</th>
                <th className="factory__num">Median time</th>
              </tr>
            </thead>
            <tbody>
              {bucket.models.map((m) => (
                <tr key={m.model} className="factory__model" data-starting={m.starting} data-on-ladder={m.onLadder}>
                  <td className="mono">{m.model}{m.starting ? <span className="factory__starts"> starts here</span> : null}</td>
                  <td className="factory__num">{m.tasks}</td>
                  <td className="factory__num">{m.firstPass}</td>
                  <td className="factory__num">{m.success}</td>
                  <td className="factory__num">{m.medianCost}</td>
                  <td className="factory__num">{m.medianTime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
