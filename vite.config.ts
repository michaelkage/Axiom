import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';

export default defineConfig({
  // The desktop app loads the built UI from file:// via Electron loadFile().
  // Relative asset URLs are required there; absolute /assets URLs resolve to the drive root.
  base: './',
  plugins: [solidPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      host: 'localhost',
    },
    watch: {
      usePolling: true,
      interval: 500,
    },
  },
  build: {
    outDir: 'out',
    minify: true,
    rollupOptions: {
      input: {
        standalone: resolve(__dirname, 'src/webview/standalone.html')
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'main.css';
          return assetInfo.name || 'asset';
        }
      }
    },
    sourcemap: process.env.GENERATE_SOURCEMAP === "true"
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/webview')
    }
  }
});
