import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'ES2020',
    outDir: 'dist',
    minify: 'terser',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
