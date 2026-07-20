import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/fb-v8/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
});
