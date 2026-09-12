import { openDatabase, migrate, SqliteMissionRepository, SqliteArtifactRepository, SqliteTaskRepository } from '../../packages/persistence/dist/index.js';
const db = openDatabase({ path: ':memory:' }); migrate(db);
const clock = { now: ()=>new Date().toISOString(), epochMs: ()=>Date.now() };
db.handle.prepare("INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at) VALUES ('ws1','w','{}','{}','{}','balanced','{}','t','t')").run();
const missions = new SqliteMissionRepository(db, clock);
const m = missions.create({ id:'m1', workspaceId:'ws1', repositoryId:null, title:'T', goal:'G', constraints:['c1'], successCriteria:['s1'] });

// partial update must not clobber unset columns
const u = missions.update('m1', { status:'EXECUTING' });
console.log('1 partial update keeps goal/constraints:', u.goal===m.goal && JSON.stringify(u.constraints)===JSON.stringify(m.constraints), '| status:', u.status);
const u2 = missions.update('m1', { statusReason: undefined, title: undefined });
console.log('2 explicit-undefined patch is a no-op:', u2.title==='T' && u2.status==='EXECUTING');

// corrupt JSON column -> fail closed
db.handle.prepare("UPDATE missions SET constraints='{not json' WHERE id='m1'").run();
console.log('3 corrupt JSON column ->', JSON.stringify(missions.get('m1').constraints), '(no throw)');

// artifacts: latest excludes superseded
const arts = new SqliteArtifactRepository(db);
const mk=(id,sup)=>({id,workspaceId:'ws1',missionId:'m1',taskId:null,createdByRunId:null,type:'ProductSpec',title:'spec '+id,
  contentRef:'m1/ProductSpec/'+id+'.md',mediaType:'text/markdown',sha256:'0'.repeat(64),byteSize:1,schemaVersion:1,
  sourceRefs:[],supersedes:sup,summary:null,createdAt:new Date(Date.parse('2026-01-0'+id.slice(-1))).toISOString()});
arts.create(mk('a1',null)); arts.create(mk('a2','a1'));
console.log('4 latest() ->', arts.latest('m1','ProductSpec').id, '(expect a2)');
// now supersede a2 with an OLDER-dated a3
arts.create({...mk('a3','a2'), createdAt:'2020-01-01T00:00:00.000Z'});
console.log('5 after a3 supersedes a2, latest() ->', arts.latest('m1','ProductSpec').id, '(a1,a2 superseded => a3)');
// FTS search injection attempt
console.log('6 fts search "spec OR 1=1 \\" NEAR(" ->', arts.search('ws1','spec OR 1=1 " NEAR(').map(a=>a.id));
console.log('7 fts search "" ->', arts.search('ws1','').length, '| "   " ->', arts.search('ws1','   ').length);
db.close();
