// Bundles the agent with esbuild. Optional build-time defaults (handy for CI):
//   RSC_SUPABASE_URL, RSC_SUPABASE_ANON_KEY  → prefilled on first launch
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultsFile = join(root, 'defaults.json');
const defaults = existsSync(defaultsFile) ? JSON.parse(readFileSync(defaultsFile, 'utf8')) : {};
const define = {
  __DEFAULT_SUPABASE_URL__: JSON.stringify(process.env.RSC_SUPABASE_URL || defaults.supabaseUrl || ''),
  __DEFAULT_SUPABASE_KEY__: JSON.stringify(process.env.RSC_SUPABASE_ANON_KEY || defaults.anonKey || ''),
};

const node = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  define,
  logLevel: 'info',
};

await Promise.all([
  build({ ...node, entryPoints: [join(root, 'src/main.ts')], outfile: join(root, 'dist/main.cjs') }),
  build({ ...node, entryPoints: [join(root, 'src/preload.ts')], outfile: join(root, 'dist/preload.cjs') }),
  build({ ...node, entryPoints: [join(root, 'src/overlay-preload.ts')], outfile: join(root, 'dist/overlay-preload.cjs') }),
  build({
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    sourcemap: true,
    entryPoints: [join(root, 'src/overlay-renderer.ts')],
    outfile: join(root, 'dist/overlay.js'),
    logLevel: 'info',
  }),
]);
