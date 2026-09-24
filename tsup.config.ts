import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/server/index.ts',
    worker: 'src/jobs/worker.ts',
    cli: 'src/cli.ts',
  },
  outDir: 'dist/server',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  splitting: true,
  // keep all npm dependencies external; they are installed in production
  skipNodeModulesBundle: true,
  tsconfig: 'tsconfig.server.json',
});
