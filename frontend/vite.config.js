import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/sparql': 'http://localhost:8000',
      '/graph':  'http://localhost:8000',
      '/stats':  'http://localhost:8000',   
      '/debug':  'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/diagnose': 'http://localhost:8000',
      '/conformance': 'http://localhost:8000',
    }
  }
})