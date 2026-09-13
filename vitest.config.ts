import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';

// Node ESM builds use explicit `.js` import specifiers (required for tsc output
// under moduleResolution: NodeNext). Vite/Vitest does not remap `.js` -> `.ts`
// by default, so this tiny pre plugin rewrites relative `.js` specifiers to the
// sibling `.ts` source file when only the `.ts` exists on disk.
function tsResolvePlugin() {
  return {
    name: 'nexplan-ts-js-resolver',
    enforce: 'pre',
    resolveId(source: string, importer?: string) {
      if (!importer) return null;
      if (!(source.startsWith('.') || source.startsWith('/'))) return null;
      if (!source.endsWith('.js')) return null;
      const base = path.resolve(path.dirname(importer), source);
      if (!fs.existsSync(base) && fs.existsSync(base.replace(/\.js$/, '.ts'))) {
        return base.replace(/\.js$/, '.ts');
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [tsResolvePlugin()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // These tests do real I/O: every board write is a git commit, the web suite
    // binds a real socket and the CLI suite spawns the actual CLI. That makes
    // them an order of magnitude slower on a 2-core CI runner than on a laptop,
    // where the slowest non-explicit test already takes ~1.6s — close enough to
    // vitest's 5s default that a busy runner turns it into a flaky failure
    // (observed once on main while the identical tree passed 8 minutes earlier).
    // Generous, still bounded: a genuine hang is reported in 30s, not never.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
