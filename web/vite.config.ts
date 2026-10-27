/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = process.env.HOTFM_API ?? 'http://localhost:18347'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18348,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/healthz': { target: api },
    },
  },
  // transformers.js runs in a worker that code-splits (onnxruntime backends).
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: {
    target: 'es2020',
    // Keep dev sourcemaps (served by Vite) but never ship them in the binary.
    sourcemap: false,
    // hls.js is a lazily loaded chunk of ~600 kB; the main bundle stays small.
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
