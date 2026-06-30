import type { ForgeConfig } from '@electron-forge/core';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Cleaner PC',
    executableName: 'cleaner-pc',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'CleanerPC',
        authors: 'Kerdanet Yvan',
        description: 'Application de maintenance PC pour Windows',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'electron/main.js',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'electron/preload.js',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.config.ts',
        },
      ],
    }),
  ],
};

export default config;
