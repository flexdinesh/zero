import { defineConfig } from 'vite'

// Serves the README cover's capture page (decision 0164); never built.
export default defineConfig({
  root: import.meta.dirname,
  server: { strictPort: false },
})
