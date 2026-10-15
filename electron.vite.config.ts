import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'voice-engine': resolve(__dirname, 'src/main/voice/voice-engine.ts'),
          'tts-worker': resolve(__dirname, 'src/main/voice/tts-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { bridge: resolve(__dirname, 'src/preload/bridge.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          panel: resolve(__dirname, 'src/renderer/panel/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          demo: resolve(__dirname, 'src/renderer/demo/index.html'),
          mic: resolve(__dirname, 'src/renderer/mic/index.html'),
        },
      },
    },
  },
});
