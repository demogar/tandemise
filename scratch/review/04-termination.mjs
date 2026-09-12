// FINDING: `child.exitCode` is null for a process killed BY A SIGNAL, so every
// liveness check in termination.ts / ClaudeCodeAdapter that reads only
// `exitCode` believes a co-operating child is still alive.
import { spawn } from 'node:child_process';
import { escalateTerminationOnAbort } from '../../packages/runtimes-core/dist/termination.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Ground truth: what does Node report for a SIGTERM-ed child?
{
  const child = spawn('sleep', ['30']);
  await sleep(150);
  child.kill('SIGTERM');
  await new Promise((r) => child.once('close', r));
  console.log('after a child exits via SIGTERM:');
  console.log('  exitCode  =', child.exitCode, '  <-- still null');
  console.log('  signalCode=', child.signalCode);
  console.log('  killed    =', child.killed);
  console.log('  => `if (child.exitCode === null)` is TRUE for a process that already died.');
}

// 2. Consequence in escalateTerminationOnAbort: onForced fires (and SIGKILL is
//    sent) even though the child obeyed SIGTERM immediately.
{
  const child = spawn('sleep', ['30']);
  const ac = new AbortController();
  let forced = false;
  escalateTerminationOnAbort(child, ac.signal, 200, () => { forced = true; });

  await sleep(150);
  ac.abort();                                   // SIGTERM
  await new Promise((r) => child.once('close', r));
  console.log('\nchild closed at', new Date().toISOString().slice(11, 23), 'signal =', child.signalCode);
  await sleep(400);                             // let the grace timer fire
  console.log('  onForced() called after a clean SIGTERM exit? ->', forced);
  console.log('  (adapter.ts:168 logs "claude code ignored SIGTERM; sent SIGKILL")');
}

// 3. The same predicate in ClaudeCodeAdapter#run\'s finally block and in
//    cancel() means a second, unnecessary SIGKILL is always sent.
