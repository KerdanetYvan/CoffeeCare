import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'electron',
        'path',
        'os',
        'fs',
        'child_process',
        'process',
        'url',
        'util',
        'events',
        'stream',
        'crypto',
      ],
    },
  },
});
