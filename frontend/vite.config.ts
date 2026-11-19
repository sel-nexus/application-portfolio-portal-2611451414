/** Configure the React build, same-origin development API proxy, and component tests. */
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: { host: '0.0.0.0', port: 5173, strictPort: true,
      proxy: { '/api': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:8000', changeOrigin: true } } },
    test: { environment: 'jsdom', setupFiles: ['./src/testSetup.ts'], include: ['src/**/*.test.tsx'],
      pool: 'forks', maxWorkers: 1, minWorkers: 1 },
  };
});
