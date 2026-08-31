import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel) => fileURLToPath(new URL(rel, import.meta.url))

const require = createRequire(import.meta.url)

function appNodeModulesResolver() {
  return {
    name: 'app-node-modules-resolver',
    async resolveId(source, importer) {
      if (!importer || !importer.includes('deepseek-harness-master')) return null
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('node:') || source.startsWith('@deepseek-ai/')) return null
      try {
        const resolved = require.resolve(source, { paths: [src('./node_modules')] })
        return resolved
      } catch {
        return null
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), appNodeModulesResolver()],
  root: 'src/renderer-react',
  base: './',
  resolve: {
    modules: [src('./node_modules'), 'node_modules'],
    alias: [
      { find: /^node:module$/, replacement: src('./src/renderer-react/node-module-stub.js') },
      // Reuse the actual dsh client component packages from the local source tree.
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: src('./vendor/deepseek-harness-master/packages/client/web/src/boot.tsx') },
      { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: src('./vendor/deepseek-harness-master/packages/client/web-react/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: src('./vendor/deepseek-harness-master/packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: src('./vendor/deepseek-harness-master/packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-attachment$/, replacement: src('./vendor/deepseek-harness-master/packages/client/ui-attachment/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-schema-form$/, replacement: src('./vendor/deepseek-harness-master/packages/client/schema-form/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-modules\/client$/, replacement: src('./vendor/deepseek-harness-master/packages/client/modules/src/client/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-theme\/styles\/(.*)$/, replacement: src('./node_modules/@deepseek-ai/dsh-client-ui-theme/lib/styles/$1') },
      { find: /^use-sync-external-store\/shim\/with-selector\.js$/, replacement: src('./node_modules/use-sync-external-store/shim/with-selector.js') },
      { find: /^clsx$/, replacement: src('./node_modules/clsx/dist/clsx.mjs') },
      { find: /^diff$/, replacement: src('./node_modules/diff/lib/index.mjs') },
      { find: /^@tanstack\/react-virtual$/, replacement: src('./node_modules/@tanstack/react-virtual/dist/esm/index.js') },
      { find: /^katex\/dist\/katex\.min\.css$/, replacement: src('./node_modules/katex/dist/katex.min.css') },
      { find: /^katex$/, replacement: src('./node_modules/katex/dist/katex.mjs') },
      { find: /^anser$/, replacement: src('./node_modules/anser/lib/index.js') },
      { find: /^shiki$/, replacement: src('./node_modules/shiki/dist/index.mjs') },
      { find: /^shiki\/core$/, replacement: src('./node_modules/shiki/dist/core.mjs') },
      { find: /^shiki\/engine\/javascript$/, replacement: src('./node_modules/shiki/dist/engine-javascript.mjs') },
      { find: /^shiki\/engine\/oniguruma$/, replacement: src('./node_modules/shiki/dist/engine-oniguruma.mjs') },
      { find: /^shiki\/langs$/, replacement: src('./node_modules/shiki/dist/langs.mjs') },
      { find: /^shiki\/themes$/, replacement: src('./node_modules/shiki/dist/themes.mjs') },
      { find: /^@shikijs\/langs$/, replacement: src('./node_modules/@shikijs/langs/dist/index.mjs') },
      { find: /^@shikijs\/langs\/(.*)$/, replacement: src('./node_modules/@shikijs/langs/dist/$1.mjs') },
      { find: /^@shikijs\/themes$/, replacement: src('./node_modules/@shikijs/themes/dist/index.mjs') },
      { find: /^@shikijs\/themes\/(.*)$/, replacement: src('./node_modules/@shikijs/themes/dist/$1.mjs') },
      // Any other @deepseek-ai workspace package resolves from this app's installed node_modules.
      { find: /^@deepseek-ai\/([^/]+)$/, replacement: src('./node_modules/@deepseek-ai/$1') },
    ],
  },
  esbuild: {
    tsconfigRaw: '{}',
  },
  define: {
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  build: {
    outDir: '../../dist/renderer-react',
    emptyOutDir: true,
  },
})
