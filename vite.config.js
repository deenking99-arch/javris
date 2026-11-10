import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('client'),
  publicDir: path.resolve('client/public'),
  build: {
    outDir: path.resolve('client/dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 7778 },
});
