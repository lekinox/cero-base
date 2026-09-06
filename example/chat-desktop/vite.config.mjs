import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [tailwindcss(), react()],
  resolve: {
    preserveSymlinks: true
  },
  optimizeDeps: {
    include: [
      'b4a',
      'z32',
      'streamx',
      'safety-catch',
      'compact-encoding',
      'bare-rpc',
      'hrpc/runtime'
    ]
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true
  }
})
