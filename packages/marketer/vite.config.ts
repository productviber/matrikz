import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'ES2020',
    outDir: 'dist',
    minify: 'esbuild',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        '__STATIC_CONTENT_MANIFEST',
      ],
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
