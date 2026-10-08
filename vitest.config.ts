import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The real module only exists inside the extension host.
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/helpers/vscodeStub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/unit/setup.ts'],
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
