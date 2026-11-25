import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = path => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: '/ui/',
  publicDir: false,
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: fromRoot('./public/ui/'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        workspace: fromRoot('./frontend/workspace/index.tsx'),
        settings: fromRoot('./frontend/settings/index.tsx'),
        tools: fromRoot('./frontend/tools/index.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: asset => asset.names.some(name => name.endsWith('.css')) ? '[name][extname]' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
