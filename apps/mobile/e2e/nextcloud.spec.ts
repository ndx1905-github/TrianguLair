/**
 * Storage wizard, Nextcloud (T-202): Login Flow v2 (server address → the login page opens → the
 * app polls → app password filled in) and the read-only public link made through the OCS Share
 * API on request. The Nextcloud endpoints are a Playwright mock (no real Nextcloud here), with
 * the CORS headers a reverse proxy would add. Also: SFTP is explained as desktop only.
 */
import type { BrowserContext, Route } from '@playwright/test';

import { autostart, expect, test } from './helpers';

const NC = 'https://cloud.triangulair.test';
const AUTH = 'Basic ' + Buffer.from('alice@example.org:App-Password-12345').toString('base64');
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, OCS-APIRequest, Accept, User-Agent',
  'access-control-allow-methods': 'GET, POST, MKCOL, OPTIONS',
};

async function mockNextcloud(context: BrowserContext, o: { approveAfter: number }) {
  const seen: string[] = [];
  let polls = 0;
  let folder = false;
  let share: object | null = null;
  const reply = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
  const ocs = (data: unknown) => ({ ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data } });
  // On the context: the login page opens in a new tab (window.open), answered here too.
  await context.route(`${NC}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    seen.push(`${m} ${url.pathname}`);
    if (url.pathname === '/login/v2/flow/flowtoken') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Nextcloud login (mock)</p>' });
    if (m === 'POST' && url.pathname === '/index.php/login/v2') return reply(route, 200, { poll: { token: 'tok', endpoint: `${NC}/login/v2/poll` }, login: `${NC}/login/v2/flow/flowtoken` });
    if (m === 'POST' && url.pathname === '/login/v2/poll') {
      if (req.postData() !== 'token=tok' || ++polls <= o.approveAfter) return reply(route, 404);
      return reply(route, 200, { server: NC, loginName: 'alice@example.org', appPassword: 'App-Password-12345' });
    }
    if (req.headers()['authorization'] !== AUTH) return reply(route, 401);
    if (url.pathname === '/ocs/v2.php/cloud/user') return reply(route, 200, ocs({ id: 'alice' }));
    if (m === 'MKCOL' && url.pathname === '/remote.php/dav/files/alice/TrianguLair/') {
      const was = folder;
      folder = true;
      return route.fulfill({ status: was ? 405 : 201, headers: CORS });
    }
    if (url.pathname === '/ocs/v2.php/apps/files_sharing/api/v1/shares') {
      if (m === 'GET') return reply(route, 200, ocs(share ? [share] : []));
      const q = new URLSearchParams(req.postData() ?? '');
      if (!folder || q.get('path') !== '/TrianguLair' || q.get('shareType') !== '3' || q.get('permissions') !== '1') return reply(route, 400, ocs([]));
      share = { id: 7, share_type: 3, permissions: 1, url: `${NC}/s/Ab12Cd34Ef`, token: 'Ab12Cd34Ef', expiration: null };
      return reply(route, 200, ocs(share));
    }
    return reply(route, 404);
  });
  return { seen, polls: () => polls };
}

test('Nextcloud: connect in the browser (Login Flow v2), then the public link made on request', async ({ page, context }) => {
  const nc = await mockNextcloud(context, { approveAfter: 2 });
  await page.goto(autostart('/storage/setup'));
  await page.getByTestId('choice-nextcloud').click({ timeout: 30_000 });
  await expect(page.getByTestId('nc-login')).toBeVisible();
  await page.getByTestId('field-ncServer').fill('cloud.triangulair.test');
  await page.getByTestId('nc-login').click();
  // The Nextcloud login page was opened in the browser.
  await expect.poll(() => nc.seen.includes('GET /login/v2/flow/flowtoken')).toBe(true);
  await expect(page.getByTestId('nc-login-waiting')).toBeVisible();
  await expect(page.getByTestId('nc-login-ok')).toContainText('alice@example.org', { timeout: 30_000 });
  expect(nc.polls()).toBe(3);
  // The manual fields are filled; the folder uses the account id, not the login name.
  await expect(page.getByTestId('field-ncUser')).toHaveValue('alice@example.org');
  await expect(page.getByTestId('field-ncPassword')).toHaveValue('App-Password-12345');
  await expect(page.getByTestId('nc-dav-url')).toContainText(`${NC}/remote.php/dav/files/alice/TrianguLair/`);

  // The public link, only when asked.
  expect(nc.seen.some((s) => s.includes('/shares'))).toBe(false);
  await page.getByTestId('nc-share').click();
  await expect(page.getByTestId('nc-share-ok')).toContainText('Public link created (read only)');
  await expect(page.getByTestId('field-ncShareLink')).toHaveValue(`${NC}/s/Ab12Cd34Ef`);
  await expect(page.getByTestId('field-readUrl')).toHaveAttribute('placeholder', `${NC}/public.php/dav/files/Ab12Cd34Ef/`);
  expect(nc.seen).toContain('MKCOL /remote.php/dav/files/alice/TrianguLair/');
  await page.screenshot({ path: 'test-results/storage-nextcloud-login-flow.png', fullPage: true });
});

test('Nextcloud: a server that cannot be reached leaves the manual form', async ({ page }) => {
  await page.route(`${NC}/**`, (r) => r.abort('connectionrefused'));
  await page.goto(autostart('/storage/setup'));
  await page.getByTestId('choice-nextcloud').click({ timeout: 30_000 });
  await page.getByTestId('field-ncServer').fill(NC);
  await page.getByTestId('nc-login').click();
  await expect(page.getByTestId('nc-login-error')).toContainText('fill in the fields by hand');
  await expect(page.getByTestId('field-ncPassword')).toBeVisible();
});

test('SFTP: explained as desktop only, with the HTTPS mode offered instead', async ({ page }) => {
  await page.goto(autostart('/storage/setup'));
  await page.getByTestId('choice-sftp').click({ timeout: 30_000 });
  await expect(page.getByTestId('sftp-desktop-only')).toContainText('only with the desktop app');
  await page.getByTestId('sftp-use-https').click();
  await expect(page.getByTestId('field-readUrl')).toBeVisible();
  await expect(page.getByTestId('field-ncServer')).toHaveCount(0);
});
