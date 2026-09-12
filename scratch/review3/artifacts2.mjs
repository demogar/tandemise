import { createFilesystemArtifactStore } from '../../packages/artifacts/dist/index.js';
import { createPaths } from '../../packages/shared/dist/index.js';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const home = new URL('./tmp8/', import.meta.url).pathname;
rmSync(home,{recursive:true,force:true}); mkdirSync(home,{recursive:true});
const paths = createPaths(home);
const store = createFilesystemArtifactStore({ paths });
const c = await store.write({ workspaceId:'ws1', missionId:'m1', type:'ProductSpec', title:'spec', body:'# hi' });
const idx = `${paths.artifacts('ws1')}/index/${c.id}.json`;

writeFileSync(idx, '{ not json');
try { await store.read(c.id); console.log('corrupt index: read SUCCEEDED (unexpected)'); }
catch (e) { console.log('corrupt index ->', e.constructor.name+':', String(e.message).slice(0,70)); }
try { console.log('corrupt index exists() ->', store.exists(c.id)); }
catch (e) { console.log('corrupt index exists() throws ->', e.constructor.name+':', String(e.message).slice(0,60)); }

// crafted index entry pointing outside the root
writeFileSync(idx, JSON.stringify({ ...c, contentRef: '../../../../../../etc/hosts' }));
try { const r = await store.read(c.id); console.log('crafted contentRef -> read', r.body.split('\n')[0].slice(0,40), '(ESCAPED ROOT)'); }
catch (e) { console.log('crafted contentRef rejected:', e.message.slice(0,60)); }
