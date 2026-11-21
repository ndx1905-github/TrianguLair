/**
 * End-to-end tests (T-119) on the web export in fixture mode: every OSM request is answered by the
 * synthetic fixtures, the base map style by a blank placeholder (see e2e/helpers.ts), so the suite
 * runs offline. Build first:
 *
 *   EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web --output-dir dist
 *   npm run e2e
 *
 * Each run serves this worktree's dist/ on a free port of its own (`E2E_PORT` fixes one), and
 * never reuses a server already listening there: it could be another worktree's build.
 *
 * The installable web app (e2e/pwa.spec.ts) runs on a second build, with the service worker and
 * under the sub-path /triangulair/, served like a plain static host (no fallback page):
 *
 *   npm run export:web:pwa:fixtures      (writes dist-pwa/)
 *
 * That project runs when dist-pwa/ exists, and always with E2E_PWA=1 (CI), where a missing build fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/** A free port, chosen once by the runner; the workers inherit it through the environment. */
function freePort(): number {
  const out = execFileSync(process.execPath, [
    '-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
  ]);
  return Number(out.toString());
}

process.env['E2E_PORT'] ??= String(freePort());
const PORT = Number(process.env['E2E_PORT']);
const CI = !!process.env['CI'];
const PWA = process.env['E2E_PWA'] === '1' || existsSync('dist-pwa/sw.js');
if (PWA) process.env['E2E_PWA_PORT'] ??= String(freePort());
const PWA_PORT = Number(process.env['E2E_PWA_PORT'] ?? 0);
/** Must match `TL_WEB_BASE` in the export:web:pwa:fixtures script. */
const PWA_BASE = '/triangulair';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', testIgnore: /pwa\.spec\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    ...(PWA
      ? [
          {
            name: 'pwa',
            testMatch: /pwa\.spec\.ts$/,
            use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, baseURL: `http://127.0.0.1:${PWA_PORT}` },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: `python3 scripts/serve.py dist ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      // Never test a build served by someone else (another worktree on the same port).
      reuseExistingServer: false,
      timeout: 30_000,
    },
    ...(PWA
      ? [
          {
            command: `python3 scripts/serve.py dist-pwa ${PWA_PORT} ${PWA_BASE}`,
            url: `http://127.0.0.1:${PWA_PORT}${PWA_BASE}/`,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
});
