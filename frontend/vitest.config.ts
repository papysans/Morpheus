/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/test-setup.ts'],
        include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
        exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
})
