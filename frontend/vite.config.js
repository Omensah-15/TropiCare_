import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['jspdf'],
  },
  build: {
    chunkSizeWarningLimit: 800,
    commonjsOptions: {
      include: [/jspdf/, /node_modules/],
    },
  },
})
