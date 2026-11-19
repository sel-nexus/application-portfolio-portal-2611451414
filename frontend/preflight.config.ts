/** Reuse the real server startup while keeping preflight separate from journey specs. */
import { defineConfig } from '@playwright/test';
import config from './playwright.config';
export default defineConfig({ ...config, testDir: '.', testMatch: '**/preflight.ts', projects: [{ name: 'preflight', testMatch: '**/preflight.ts' }] });
