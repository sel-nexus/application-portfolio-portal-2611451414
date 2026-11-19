/** Launch both real tiers for later browser verification against a dedicated Mongo database. */
import { defineConfig } from '@playwright/test';
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';
const apiURL = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const database = process.env.E2E_MONGODB_DB || 'portal_e2e';
if (!database.startsWith('portal_e2e')) throw new Error('E2E_MONGODB_DB must be a dedicated portal_e2e database');
export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, timeout: 30000,
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'cd ../backend && "$HOME/venvs/app/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8000',
      url: `${apiURL}/api/health`, reuseExistingServer: false,
      env: { MONGODB_DB: database, JWT_SECRET: process.env.E2E_JWT_SECRET || 'dev-secret-change-in-production' } },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173', url: baseURL,
      reuseExistingServer: false, env: { API_PROXY_TARGET: apiURL } },
  ],
});
