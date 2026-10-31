// Every workspace package ships at the app's version (release-please bumps
// them together), so each one must be listed in release-please's extra-files
// and match the manifest. A new package that is missed here would silently
// keep its first version while the app moves on.
//
//   node scratch/version-check.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const config = read('release-please-config.json');
const manifest = read('.release-please-manifest.json');
const version = manifest['.'];
const listed = new Set(config.packages['.']['extra-files'].map((e) => (typeof e === 'string' ? e : e.path)));

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`); }
};

for (const dir of ['apps', 'packages']) {
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}/package.json`;
    if (!existsSync(join(root, path))) continue;
    check(`${path} is bumped by release-please`, listed.has(path));
    check(`${path} is at ${version}`, read(path).version === version, read(path).version);
  }
}

console.log(failures.length === 0 ? `\nALL ${passed} VERSION CHECKS PASSED` : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
