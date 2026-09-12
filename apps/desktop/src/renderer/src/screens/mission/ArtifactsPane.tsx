import { useState } from 'react';
import type { MissionDetail } from '@tandemise/api-contract';
import { ArtifactReader } from '../artifacts/ArtifactReader.js';
import { ArtifactRows } from '../artifacts/ArtifactRows.js';
import { Empty } from '../../components/primitives.js';

export function ArtifactsPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(detail.artifacts[0]?.id ?? null);

  if (detail.artifacts.length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="card">
            <Empty
              icon="artifacts"
              title="No artifacts yet"
              body="Roles hand work to each other as typed artifacts — a spec, a plan, a review report. They appear here as they are produced."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader__list">
        <ArtifactRows artifacts={detail.artifacts} selectedId={selected} onSelect={setSelected} groupByType />
      </div>
      <div className="reader__pane">
        <ArtifactReader id={selected} />
      </div>
    </div>
  );
}
