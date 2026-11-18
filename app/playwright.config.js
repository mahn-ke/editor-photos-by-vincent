import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    testMatch: /.*\.spec\.js$/,
    workers: 1,
    timeout: 10 * 60 * 1000,
    reporter: [['list'], ['html', { outputFolder: 'e2e/report/html', open: 'never' }]],
    use: { baseURL: process.env.E2E_APP_URL || 'http://localhost:3024' },
});
