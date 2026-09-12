import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { PACKAGES, APPS } from './packages.mjs';

const ref = (n) => ({ path: `../${n}` });

function writePkg(dir, name, spec, isApp) {
  mkdirSync(`${dir}/src`, { recursive: true });
  const deps = Object.fromEntries([
    ...spec.deps.map((d) => [`@tandemise/${d}`, '0.1.0']),
    ...Object.entries(spec.ext ?? {}),
  ]);
  const pkg = {
    name: `@tandemise/${name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    scripts: { build: 'tsc -b' },
    dependencies: deps,
    ...(spec.dev ? { devDependencies: spec.dev } : {}),
  };
  if (isApp) { pkg.main = './dist/main.js'; delete pkg.types; delete pkg.exports; }
  writeFileSync(`${dir}/package.json`, JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: './src', outDir: './dist' },
    include: ['src/**/*'],
    references: spec.deps.map((d) => ({ path: `../../packages/${d}` })),
  }, null, 2) + '\n');
  const entry = `${dir}/src/${isApp ? 'main.ts' : 'index.ts'}`;
  if (!existsSync(entry)) writeFileSync(entry, `export {};\n`);
}

for (const [name, spec] of Object.entries(PACKAGES)) writePkg(`packages/${name}`, name, spec, false);
for (const [name, spec] of Object.entries(APPS)) writePkg(`apps/${name}`, name, spec, true);

writeFileSync('tsconfig.build.json', JSON.stringify({
  files: [],
  references: [
    ...Object.keys(PACKAGES).map((n) => ({ path: `./packages/${n}` })),
    ...Object.keys(APPS).map((n) => ({ path: `./apps/${n}` })),
  ],
}, null, 2) + '\n');
console.log('scaffolded');
