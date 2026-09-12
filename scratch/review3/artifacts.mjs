import { createFilesystemArtifactStore } from '../../packages/artifacts/dist/index.js';
import { createPaths } from '../../packages/shared/dist/index.js';
import { rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const home = new URL('./tmp7/', import.meta.url).pathname;
rmSync(home,{recursive:true,force:true}); mkdirSync(home,{recursive:true});
const paths = createPaths(home);
const store = createFilesystemArtifactStore({ paths });
const base = { workspaceId:'ws1', missionId:'m1' };

// 1. content addressing: identical bytes twice
const a = await store.write({ ...base, type:'Evidence', title:'shot', body:'SAME BYTES' });
const b = await store.write({ ...base, type:'Evidence', title:'shot again', body:'SAME BYTES' });
console.log('1 dedup: sameRef=', a.contentRef===b.contentRef, 'blobs on disk=',
  execSync(`find ${paths.artifacts('ws1')}/blobs -type f | wc -l`).toString().trim(), 'sha=', a.sha256.slice(0,12));

// 2. contentRef absolute?
const c = await store.write({ ...base, type:'ProductSpec', title:'spec', body:'# hi' });
console.log('2 contentRef:', JSON.stringify(c.contentRef), 'absolute?', c.contentRef.startsWith('/'));

// 3. hash is over the body bytes, not the manifest
console.log('3 hash correct:', c.sha256 === execSync(`printf '%s' '# hi' | shasum -a 256`).toString().split(' ')[0]);

// 4. traversal via type (unvalidated at the port boundary)
try {
  const evil = await store.write({ ...base, type:'../../../../../../tmp/pwned', title:'t', body:'ESCAPED' });
  console.log('4 traversal contentRef:', evil.contentRef, '-> resolved:', store.resolvePath(evil),
    'escaped root?', !store.resolvePath(evil).startsWith(paths.artifacts('ws1')));
} catch (e) { console.log('4 traversal rejected:', e.message); }

// 5. traversal via missionId
try {
  const evil2 = await store.write({ workspaceId:'ws1', missionId:'../../../../../../tmp/pwned2', type:'ProductSpec', title:'t', body:'ESCAPED2' });
  console.log('5 missionId traversal ->', store.resolvePath(evil2), existsSync('/tmp/pwned2') ? 'WROTE OUTSIDE ROOT' : '');
} catch (e) { console.log('5 rejected:', e.message); }

// 6. title with separators in it
const t = await store.write({ ...base, type:'ProductSpec', title:'../../escape', body:'x' });
console.log('6 title in path?', t.contentRef.includes('escape'));

// 7. corrupt index json
const idx = `${paths.artifacts('ws1')}/index/${c.id}.json`;
require_ = null;
const fs = await import('node:fs');
fs.writeFileSync(idx, '{ not json');
try { await store.read(c.id); console.log('7 corrupt index: read SUCCEEDED (unexpected)'); }
catch (e) { console.log('7 corrupt index ->', e.constructor.name, JSON.stringify(String(e.message).slice(0,80))); }
