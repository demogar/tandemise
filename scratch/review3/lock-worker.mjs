import { InstanceLock } from '../../apps/daemon/dist/http/identity.js';
const [,, home] = process.argv;
const spin=(ms)=>{const t=Date.now()+ms;while(Date.now()<t){}};
spin(Math.max(0, Number(process.env.START_AT)-Date.now()));
try { new InstanceLock(home).acquire(); process.stdout.write('ACQUIRED\n'); }
catch (e) { process.stdout.write('REFUSED: '+e.message+'\n'); }
setTimeout(()=>{}, 1500);
