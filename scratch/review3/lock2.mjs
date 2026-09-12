import { InstanceLock } from '../../apps/daemon/dist/http/identity.js';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
const home = new URL('./tmp6/', import.meta.url).pathname;
rmSync(home,{recursive:true,force:true}); mkdirSync(home,{recursive:true});
// A crashed daemon's pid was recycled by an unrelated process (pid 1 = launchd, alive, EPERM).
writeFileSync(home+'daemon.lock','1');
try { new InstanceLock(home).acquire(); console.log('acquired (stale lock reclaimed)'); }
catch (e) { console.log('REFUSED ->', e.message); }
