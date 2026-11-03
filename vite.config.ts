import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the same build works in the Tauri desktop shell and under /app/ on the web.
export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
})
