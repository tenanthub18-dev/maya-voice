// Browser verification of real local auth/data; no phone calls or SMS are sent.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(resolve(root, 'apps/web/package.json'));
const {chromium} = require('@playwright/test');
const state = JSON.parse(readFileSync(resolve(root, 'tmp/phone-test/runtime.json'), 'utf8'));
const base = process.argv[2] || state.env.NEXT_PUBLIC_APP_URL;
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({viewport: {width: 390, height: 844}});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(state.email);
  await page.locator('input[name="password"]').fill(state.password);
  await Promise.all([
    page.waitForURL('**/home', {timeout: 45000}),
    page.locator('button[name="intent"][value="password"]').click(),
  ]);
  for (const route of ['/home', '/calls', '/bookings', '/agent?tab=knowledge&knowledge=menu', '/agent?tab=knowledge&knowledge=hours', '/agent?tab=knowledge&knowledge=faqs', '/settings']) {
    const response = await page.goto(base + route);
    if (response.status() !== 200 || !page.url().endsWith(route)) {
      throw new Error(`${route}: HTTP ${response.status()} or unexpected redirect`);
    }
    if (!(await page.locator('body').innerText()).includes(state.env.VOICE_DEMO_RESTAURANT_NAME || 'Maya Test Restaurant')) {
      throw new Error(`${route}: expected real local restaurant is absent`);
    }
    await page.screenshot({path: resolve(root, `tmp/phone-test/${route.slice(1).replace(/[^a-z0-9-]/gi, '-')}.png`), fullPage: true});
    console.log(`${route}: real authenticated dashboard HTTP 200`);
  }
  console.log(`Browser page errors: ${errors.length}`);
  if (errors.length) throw new Error('Browser reported application errors; inspect locally');
} finally {
  await browser.close();
}
