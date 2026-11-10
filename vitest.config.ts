import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Tests run against sources, so a demo's `backseat-ai` import does not need a build first. Exact matches, so the
    // root's alias does not also swallow its subpaths.
    alias: [
      { find: /^backseat-ai$/, replacement: fileURLToPath(new URL('packages/backseat-ai/src/index.ts', import.meta.url)) },
      { find: /^backseat-ai\/(cli)$/, replacement: fileURLToPath(new URL('packages/backseat-ai/src/$1/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
})
