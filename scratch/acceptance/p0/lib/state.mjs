import { loadEnv, client } from './api.mjs';
const env = loadEnv('/tmp/tdm-p0'); const api = client(env); const id = process.argv[2];
const m = await api.get('/v1/missions/' + id); console.log(m.mission.status, m.mission.statusReason ?? '');
for (const t of await api.get('/v1/missions/' + id + '/tasks')) console.log(' ', t.key.padEnd(13), t.status.padEnd(18), '| by', (t.assignee?.name ?? '-').padEnd(20), '| resp', (t.responsible?.name ?? '-').padEnd(20), '|', t.needsAttention ? 'ATTENTION ' : '', t.statusReason ?? '');
for (const v of await api.get('/v1/approvals?missionId=' + id + '&status=PENDING')) console.log('  APR', v.approval.kind, '|', v.approval.title, '| to', JSON.stringify(v.addressees?.map((a) => a.name) ?? v.approval.addressees), '| lvl', v.approval.escalationLevel);
