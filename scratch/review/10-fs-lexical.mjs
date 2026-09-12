// The lexical check uses the RAW roots; only the physical check uses realpath.
// So on macOS a root spelled `/tmp/x` rejects the very same path spelled
// `/private/tmp/x` - the failure the class comment says it fixed.
import { mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScopedFileSystem } from '../../packages/execution-core/dist/filesystem.js';

const root = '/tmp/tdm-lexical-demo';
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'a.txt'), 'hello');

const real = realpathSync(root);
console.log('root as given :', root);
console.log('root realpath :', real);
console.log('(they differ) :', root !== real);

const fs = new ScopedFileSystem(root);
for (const p of ['a.txt', join(root, 'a.txt'), join(real, 'a.txt')]) {
  try {
    console.log(`resolve(${JSON.stringify(p)}) -> ok`, await fs.read(p) === 'hello' ? '(read ok)' : '');
  } catch (e) {
    console.log(`resolve(${JSON.stringify(p)}) -> ${e.code}: ${e.message}`);
  }
}

// and the reverse: base given as the realpath, path given as /tmp/...
const fs2 = new ScopedFileSystem(real);
try {
  await fs2.read(join(root, 'a.txt'));
  console.log('\nreverse direction (base=realpath, path=/tmp/...) -> ok');
} catch (e) {
  console.log('\nreverse direction (base=realpath, path=/tmp/...) ->', e.code);
}

rmSync(root, { recursive: true, force: true });
