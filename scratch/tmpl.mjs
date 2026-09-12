import { renderArtifactTemplate } from '/Users/you/projects/tandemise/packages/artifacts/dist/index.js';
for (const t of ['ReviewReport','ChangeSet']) { console.log(`########## ${t}`); console.log(renderArtifactTemplate(t)); }
