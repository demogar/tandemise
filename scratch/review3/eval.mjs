import { GateFactBuilder, QUALITY_GATES, evaluateNamedGate } from '../../packages/evaluation/dist/index.js';
const mk = (n,o,t='task1') => ({ id:'c'+n, missionId:'m1', taskId:t, runId:null, name:n, outcome:o, detail:'', command:null, exitCode:null, durationMs:0, outputRef:null, createdAt:'t' });

// 1. all criteria SKIP
let f = new GateFactBuilder().withQa({ criteria:[{criterion:'AC1',outcome:'SKIP'},{criterion:'AC2',outcome:'SKIP'}], blockingDefects:0 }).build();
console.log('1 all-SKIP coverage =', f['qa.acceptance_criteria_coverage']);

// 2. 1 PASS + 9 SKIP  -> "100% coverage"
f = new GateFactBuilder()
  .withQa({ criteria:[{criterion:'AC1',outcome:'PASS'}, ...Array.from({length:9},(_,i)=>({criterion:'AC'+(i+2),outcome:'SKIP'}))], blockingDefects:0 })
  .withSecurityChecks([mk('checks.sec','PASS')], ['checks.sec'])
  .withApprovals([{ kind:'release', status:'APPROVED' }])
  .build();
console.log('2 1-PASS+9-SKIP coverage =', f['qa.acceptance_criteria_coverage'],
  '=> ready_to_ship passes:', evaluateNamedGate('ready_to_ship', f).passed);

// 3. unmeasured facts never pass
const empty = new GateFactBuilder().build();
console.log('3 empty facts ready_to_ship:', evaluateNamedGate('ready_to_ship', empty).passed,
  '| ready_for_qa:', evaluateNamedGate('ready_for_qa', empty).passed);

// 4. withChecks collapses across tasks: taskA FAIL, taskB PASS (latestChecks orders by task_id)
const facts4 = new GateFactBuilder().withChecks([mk('checks.tests','FAIL','taskA'), mk('checks.tests','PASS','taskB')]).build();
console.log('4 mission-wide checks.tests with taskA=FAIL taskB=PASS ->', facts4['checks.tests']);

// 5. approvals: mixed EXPIRED/APPROVED is order-dependent
const ap = (status)=>({kind:'release',status});
console.log('5 [APPROVED,EXPIRED] ->', new GateFactBuilder().withApprovals([ap('APPROVED'),ap('EXPIRED')]).build()['approval.release_candidate'],
            '| [EXPIRED,APPROVED] ->', new GateFactBuilder().withApprovals([ap('EXPIRED'),ap('APPROVED')]).build()['approval.release_candidate']);

// 6. withChecks order dependence
console.log('6 [FAIL then PASS] ->', new GateFactBuilder().withChecks([mk('checks.tests','FAIL'),mk('checks.tests','PASS')]).build()['checks.tests'],
            '| [PASS then FAIL] ->', new GateFactBuilder().withChecks([mk('checks.tests','PASS'),mk('checks.tests','FAIL')]).build()['checks.tests']);
