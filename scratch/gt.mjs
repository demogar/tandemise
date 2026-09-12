import { evaluateGate, validateGate, gateDependencies, topologicalOrder, findCycle, validateMissionPlan } from '/Users/you/projects/tandemise/packages/domain/dist/index.js';
let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if(!ok){fail++;console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want));} };

t('simple pass', evaluateGate('checks.tests == PASS', {'checks.tests':'PASS'}).passed, true);
t('simple fail', evaluateGate('checks.tests == PASS', {'checks.tests':'FAIL'}).passed, false);
t('missing fact never passes', evaluateGate('checks.tests == PASS', {}).passed, false);
t('and', evaluateGate('a == PASS && b == PASS', {a:'PASS',b:'PASS'}).passed, true);
t('and fail', evaluateGate('a == PASS && b == PASS', {a:'PASS',b:'FAIL'}).passed, false);
t('numeric', evaluateGate('review.blocking_findings == 0', {'review.blocking_findings':0}).passed, true);
t('numeric gt', evaluateGate('qa.coverage >= 100%', {'qa.coverage':100}).passed, true);
t('numeric gt fail', evaluateGate('qa.coverage >= 100%', {'qa.coverage':80}).passed, false);
t('bool fact', evaluateGate('artifact.ChangeSet.exists', {'artifact.ChangeSet.exists':true}).passed, true);
t('negation', evaluateGate('!artifact.x.exists', {'artifact.x.exists':false}).passed, true);
t('parens or', evaluateGate('(a == PASS || b == PASS) && c == PASS', {a:'FAIL',b:'PASS',c:'PASS'}).passed, true);
t('PASS normalizes to true', evaluateGate('checks.tests', {'checks.tests':'PASS'}).passed, true);
t('FAIL normalizes to false', evaluateGate('checks.tests', {'checks.tests':'FAIL'}).passed, false);
t('deps', [...gateDependencies('a.b == PASS && c.d >= 1')].sort(), ['a.b','c.d']);
t('invalid gate', validateGate('a == ').ok, false);
t('valid gate', validateGate('a == PASS').ok, true);
const detail = evaluateGate('checks.typecheck == PASS && checks.tests == PASS', {'checks.typecheck':'PASS','checks.tests':'FAIL'}).detail;
t('explains only unmet', detail.includes('checks.tests') && !detail.includes('typecheck'), true);

// DAG
const mk = (key, dependsOn=[], outputs=[], inputs=[]) => ({key,title:key,objective:'',roleId:'development',dependsOn,requiredCapabilities:[],inputArtifacts:inputs.map(type=>({type,required:true})),expectedOutputs:outputs,executionPolicy:{isolation:'none',maxWallTimeMs:1000,capabilities:[]},approvalPolicy:{beforeStart:false,onCompletion:false},retryPolicy:{maxAttempts:1,backoffMs:0,onExhausted:'fail'},completionGate:null});
t('topo', topologicalOrder([mk('c',['b']),mk('a'),mk('b',['a'])]), {ok:true,value:['a','b','c']});
t('cycle detected', findCycle([mk('a',['b']),mk('b',['a'])]) !== null, true);
const ctx = { knownRoleIds: new Set(['development','product']), satisfiableCapabilities: new Set() };
const good = validateMissionPlan({summary:'s',tasks:[mk('spec',[],['ProductSpec']),mk('impl',['spec'],['ChangeSet'],['ProductSpec'])]}, ctx);
t('valid plan ok', good.ok, true);
const bad = validateMissionPlan({summary:'s',tasks:[mk('impl',[],['ChangeSet'],['ProductSpec']),mk('spec',[],['ProductSpec'])]}, ctx);
t('input not upstream rejected', bad.ok, false);
if(!bad.ok) t('names the reason', bad.error.some(i=>i.message.includes('not an upstream dependency')), true);
const cyc = validateMissionPlan({summary:'s',tasks:[mk('a',['b']),mk('b',['a'])]}, ctx);
t('cyclic plan rejected', cyc.ok, false);
const unknownRole = validateMissionPlan({summary:'s',tasks:[{...mk('a'),roleId:'wizard'}]}, ctx);
t('unknown role rejected', unknownRole.ok, false);
console.log(fail===0 ? '✅ all domain logic checks passed' : `❌ ${fail} failures`);
process.exit(fail?1:0);
