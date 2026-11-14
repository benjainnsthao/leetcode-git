// Bundles the extension into dist/, ready for "Load unpacked".
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const out = 'dist';

const common = {
  bundle: true,
  target: 'chrome111',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

const bundles = [
  { entryPoints: ['src/background/index.ts'], outfile: `${out}/background.js`, format: 'esm' },
  { entryPoints: ['src/content/index.ts'], outfile: `${out}/content.js`, format: 'iife' },
  { entryPoints: ['src/page/bridge.ts'], outfile: `${out}/bridge.js`, format: 'iife' },
  { entryPoints: ['src/options/options.ts'], outfile: `${out}/options.js`, format: 'iife' },
  { entryPoints: ['src/popup/popup.ts'], outfile: `${out}/popup.js`, format: 'iife' },
];

const statics = [
  ['src/manifest.json', 'manifest.json'],
  ['src/options/options.html', 'options.html'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/ui.css', 'ui.css'],
  ['src/icons', 'icons'],
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [from, to] of statics) await cp(from, `${out}/${to}`, { recursive: true });

if (watch) {
  for (const b of bundles) (await context({ ...common, ...b })).watch();
  console.log('watching (static files are copied once at start)');
} else {
  await Promise.all(bundles.map((b) => build({ ...common, ...b })));
}
