// Bundles the Lists plugin to a single ES module (dist/main.js).
//
// Shared libraries (react, react/jsx-runtime, framer-motion) are resolved to
// shims that read the host's copies at runtime, so the plugin's components
// run on the host React tree (see docs/plugins/UI_PLUGINS.md). Everything
// else (zustand, lucide-react) is bundled in.
//
// Run from the repository root (resolves esbuild from the root node_modules):
//   node plugins/lists/build.mjs

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const hostLibShims = {
  name: 'host-lib-shims',
  setup(b) {
    b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
      path: path.join(dir, 'shims', 'jsx-runtime.cjs'),
    }));
    b.onResolve({ filter: /^react$/ }, () => ({
      path: path.join(dir, 'shims', 'react.cjs'),
    }));
    b.onResolve({ filter: /^framer-motion$/ }, () => ({
      path: path.join(dir, 'shims', 'framer-motion.cjs'),
    }));
  },
};

await build({
  entryPoints: [path.join(dir, 'src', 'index.tsx')],
  outfile: path.join(dir, 'dist', 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  plugins: [hostLibShims],
  logLevel: 'info',
});
