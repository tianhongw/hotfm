/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = process.env.HOTFM_API ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/healthz': { target: api },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    // hls.js is a lazily loaded chunk of ~600 kB; the main bundle stays small.
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
