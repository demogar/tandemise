// F2/F3: artifact store — id/type path traversal, dedup, contentRef relativity.
import { createFilesystemArtifactStore } from '@tandemise/artifacts';
import { createPaths } from '@tandemise/shared';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tnd-'));
const paths = createPaths(home);
const store = createFilesystemArtifactStore({ paths });

// ---------------------------------------------------------------- A: dedup
const a = await store.write({ workspaceId: 'ws_1', missionId: 'ms_1', type: 'Evidence', title: 'shot', body: new Uint8Array([1, 2, 3]) });
const b = await store.write({ workspaceId: 'ws_1', missionId: 'ms_1', type: 'Evidence', title: 'shot again', body: new Uint8Array([1, 2, 3]) });
console.log('A. content-addressed dedup');
console.log('   same contentRef      :', a.contentRef === b.contentRef, a.contentRef);
console.log('   distinct artifact ids:', a.id !== b.id);
console.log('   sha over body bytes  :', a.sha256 === '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cf331');

// ------------------------------------------------- B: contentRef never absolute
const m = await store.write({ workspaceId: 'ws_1', missionId: 'ms_1', type: 'ProductSpec', title: 'Spec', body: '# hi' });
console.log('B. contentRef relative  :', !m.contentRef.startsWith('/'), m.contentRef);

// ----------------------------------------------- C: traversal via artifact TYPE
const evil = await store.write({
  workspaceId: 'ws_1', missionId: '../../../../..', type: '../../../../../../../../tmp/tnd-escape',
  title: 'x', body: 'ESCAPED',
});
console.log('C. traversal via missionId/type');
console.log('   contentRef           :', evil.contentRef);
console.log('   wrote /tmp/tnd-escape:', existsSync('/tmp/tnd-escape'));
if (existsSync('/tmp/tnd-escape')) {
  const f = (await import('node:fs')).readdirSync('/tmp/tnd-escape');
  console.log('   files there          :', f);
}

// ---------------------------------------------------- D: traversal via artifact ID
// Plant a manifest anywhere on disk, then resolve it by a traversing id.
const outside = join(home, 'outside');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'pwn.json'), JSON.stringify({
  id: 'pwn', workspaceId: 'ws_1', missionId: 'ms_1', type: 'Evidence',
  title: 'x', contentRef: '../'.repeat(30) + 'etc/hosts', mediaType: 'text/plain',
  sha256: '0', byteSize: 0, schemaVersion: 1, sourceRefs: [], supersedes: null,
  summary: null, createdAt: 'x',
}));
const relToIndex = '../../../../outside/pwn';   // <root>/workspaces/ws_1/artifacts/index/ -> <home>/outside
try {
  const got = await store.read(relToIndex);
  console.log('D. traversal via artifact id');
  console.log('   read a manifest from outside the artifact root:', got.manifest.id);
  console.log('   and then read an arbitrary file; first line   :', JSON.stringify(got.body.split('\n')[0]));
} catch (e) {
  console.log('D. traversal via artifact id -> refused:', String(e).slice(0, 160));
}
console.log('\nhome =', home);
