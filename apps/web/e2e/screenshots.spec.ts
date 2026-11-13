import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect, test, type Page} from '@playwright/test';

// Playwright screenshot API: https://playwright.dev/docs/screenshots
const enabled = process.env.SCREENSHOTS === '1';
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
const outputRoot = resolve(process.cwd(), '../../tmp/screenshots');
const routes = ['/', '/login', '/signup', '/invite/accept', '/billing/success', '/billing/cancel', '/onboarding/1', '/onboarding/2', '/onboarding/3', '/onboarding/4', '/onboarding/5', '/onboarding/6', '/onboarding/7', '/home', '/calls', '/calls/call-001', '/bookings', '/orders', '/agent', '/phone', '/analytics', '/settings', '/admin'];
const viewports = [
  {name: 'mobile', width: 375, height: 812},
  {name: 'tablet', width: 768, height: 1024},
  {name: 'desktop', width: 1280, height: 900},
] as const;

test.describe('route screenshot matrix', () => {
  test.skip(!enabled, 'Set SCREENSHOTS=1 to capture the visual review matrix.');
  test.skip(enabled && !baseURL, 'Set PLAYWRIGHT_BASE_URL to an already running web app.');

  for (const viewport of viewports) {
    for (const theme of ['light', 'dark'] as const) {
      for (const route of routes) {
        test(`${viewport.name} ${theme} ${route}`, async ({page}: {page: Page}) => {
          await mkdir(outputRoot, {recursive: true});
          await page.setViewportSize(viewport);
          await page.emulateMedia({colorScheme: theme});
          await page.goto(new URL(route, baseURL).toString(), {waitUntil: 'networkidle'});
          await page.evaluate((selectedTheme) => document.documentElement.setAttribute('data-theme', selectedTheme), theme);
          await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
          const slug = route === '/' ? 'landing' : route.slice(1).replaceAll('/', '--');
          await page.screenshot({path: resolve(outputRoot, `${slug}--${viewport.name}--${theme}.png`), fullPage: true});
        });
      }
    }
  }
});
