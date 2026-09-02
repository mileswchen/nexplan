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
  },
});
