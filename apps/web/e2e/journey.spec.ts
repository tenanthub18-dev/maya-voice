import {createRequire} from 'node:module';
import {expect, test, type Page, type TestInfo} from '@playwright/test';

// Playwright locators, network events, routing, and browser-context APIs:
// https://playwright.dev/docs/locators
// https://playwright.dev/docs/network
// https://playwright.dev/docs/api/class-browsercontext
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const restaurantId = '11111111-1111-4111-8111-111111111111';
const consoleErrors = new WeakMap<Page, string[]>();

type AxeViolation = {
  id: string;
  impact: string | null;
  nodes: Array<{target: string[]; failureSummary?: string}>;
};

async function assertPageQuality(page: Page, testInfo: TestInfo): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Next streams metadata after soft navigations; a user always ends up with a title.
  await expect(page).toHaveTitle(/.+/);
  if (testInfo.project.name === 'mobile') {
    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));
    expect(overflow.scrollWidth, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(overflow.clientWidth);
  }

  // axe browser API: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#api-name-axerun
  await page.addScriptTag({path: axePath});
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & {
      axe: {run(context: Document): Promise<{violations: AxeViolation[]}>};
    }).axe;
    // A server-action refresh can briefly swap <title>; wait for it to settle so axe judges the settled page.
    for (let i = 0; i < 100 && !document.title.trim(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return (await axe.run(document)).violations;
  });
  expect(violations, `axe violations on ${page.url()}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

test.beforeEach(async ({page}) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});

test.afterEach(async ({page}) => {
  const errors = consoleErrors.get(page) ?? [];
  expect(errors, `browser console errors:\n${errors.join('\n')}`).toEqual([]);
});

async function continueOnboarding(page: Page, step: number, testInfo: TestInfo): Promise<void> {
  const label = step === 6 ? 'Finish setup' : 'Continue';
  await page.getByRole('button', {name: label, exact: true}).click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${step + 1}$`));
  await assertPageQuality(page, testInfo);
}

function bookingDateTime(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(19, 0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

test('owner journey and staff authorization boundaries', async ({page, context}, testInfo) => {
  await page.goto('/');
  await assertPageQuality(page, testInfo);
  await page.locator('button[name="intent"][value="demo"]').first().click();
  await expect(page).toHaveURL(/\/home$/);
  await assertPageQuality(page, testInfo);

  await page.goto('/onboarding/1');
  await assertPageQuality(page, testInfo);
  await page.getByLabel('Restaurant name').fill(`Harbour Table ${testInfo.project.name}`);
  await page.getByLabel('Street address').fill('88 Queens Quay W, Toronto, ON');
  await continueOnboarding(page, 1, testInfo);

  await page.getByLabel('Website URL').fill('https://example.com/restaurant');
  const importResponse = page.waitForResponse((response) => response.url().endsWith('/api/import') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Import website'}).click();
  expect((await importResponse).status()).toBe(202);
  await expect(page.getByText('Import ready to review')).toBeVisible();
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  await expect(page).toHaveURL(/\/onboarding\/3$/);
  await assertPageQuality(page, testInfo);

  await continueOnboarding(page, 3, testInfo);
  await continueOnboarding(page, 4, testInfo);
  await continueOnboarding(page, 5, testInfo);
  await continueOnboarding(page, 6, testInfo);

  await page.getByRole('button', {name: 'Release number'}).click();
  const releaseDialog = page.getByRole('dialog', {name: 'Confirm release'});
  await releaseDialog.getByLabel('Reason for release').fill('Playwright mock-mode lifecycle test');
  await releaseDialog.getByRole('button', {name: 'Confirm release'}).click();
  await expect(page.getByText(/Number released/)).toBeVisible();

  const searchResponse = page.waitForResponse((response) => response.url().endsWith('/api/telnyx/numbers/search'));
  await page.getByRole('button', {name: 'Search numbers'}).click();
  expect((await searchResponse).status()).toBe(200);
  const buyButton = page.getByRole('button', {name: /^Buy \+/}).first();
  const buyResponse = page.waitForResponse((response) => response.url().endsWith('/api/telnyx/numbers/buy'));
  await buyButton.click();
  expect((await buyResponse).status()).toBe(201);
  await expect(page.getByText('+19705555098', {exact: true})).toBeVisible();

  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Mock Stripe Checkout</title><h1>Mock Stripe Checkout</h1>',
  }));
  const checkoutResponse = page.waitForResponse((response) => response.url().endsWith('/api/billing/checkout'));
  await page.getByRole('button', {name: 'Continue to secure checkout'}).click();
  expect((await checkoutResponse).status()).toBe(200);
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
  await expect(page.getByRole('heading', {name: 'Mock Stripe Checkout'})).toBeVisible();
  await page.goto('/billing/success');
  await assertPageQuality(page, testInfo);

  await page.goto('/agent');
  await assertPageQuality(page, testInfo);
  await page.getByLabel('Persona name').fill(`Maya ${testInfo.project.name}`);
  await page.getByRole('button', {name: 'Save changes'}).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.getByRole('button', {name: 'Publish', exact: true}).click();
  await expect(page.getByText('Draft published.')).toBeVisible();
  await assertPageQuality(page, testInfo);

  await page.goto('/agent?tab=rules');
  await assertPageQuality(page, testInfo);
  await page.getByLabel('Covers per slot').fill('8');
  await page.getByRole('button', {name: 'Save changes'}).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();

  // Headless Chromium has no audio input device (getUserMedia rejects with NotSupportedError), so give the
  // page a synthetic microphone stream built from Web Audio: https://developer.mozilla.org/docs/Web/API/AudioContext/createMediaStreamDestination
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      context.createOscillator().connect(destination);
      return destination.stream;
    };
  });
  await page.goto('/agent?tab=testCall');
  await page.getByRole('button', {name: 'Start test call'}).click();
  await expect(page.getByText('Connected', {exact: true})).toBeVisible();
  await expect(page.getByText(/simulated call will not create a booking/i)).toBeVisible();
  await page.getByRole('button', {name: 'End test call'}).click();
  await assertPageQuality(page, testInfo);

  await page.goto('/calls');
  await expect(page.getByRole('heading', {name: 'Calls', exact: true})).toBeVisible();
  await assertPageQuality(page, testInfo);
  await page.locator('a[href^="/calls/"]').first().click();
  await expect(page).toHaveURL(/\/calls\/call-\d+$/);
  await expect(page.getByRole('heading', {name: 'Transcript'})).toBeVisible();
  await assertPageQuality(page, testInfo);

  const projectDayOffset = {mobile: 2, tablet: 3, desktop: 4}[testInfo.project.name] ?? 5;
  const startsAt = bookingDateTime(projectDayOffset);
  await page.goto('/bookings?view=list&create=1');
  await page.getByLabel('Guest name').fill(`E2E Guest ${testInfo.project.name}`);
  await page.getByLabel('Phone number').fill('+14165550999');
  await page.getByLabel('Party size').fill('8');
  await page.getByLabel('Date and time').fill(startsAt);
  await page.getByRole('button', {name: 'Create booking'}).click();
  await expect(page.getByText('Booking saved.')).toBeVisible();

  await page.goto('/bookings?view=list&create=1');
  await page.getByLabel('Guest name').fill(`Duplicate Guest ${testInfo.project.name}`);
  await page.getByLabel('Phone number').fill('+14165550888');
  await page.getByLabel('Party size').fill('1');
  await page.getByLabel('Date and time').fill(startsAt);
  await page.getByRole('button', {name: 'Create booking'}).click();
  await expect(page.locator('[role="alert"]:not([id="__next-route-announcer__"])')).toContainText('That time no longer has enough capacity');
  await page.getByRole('link', {name: 'Close booking drawer'}).click();
  await assertPageQuality(page, testInfo);

  await page.goto('/orders');
  const moveButton = page.getByRole('button', {name: /^Move to /}).first();
  const moveTarget = (await moveButton.textContent())?.replace('Move to ', '').trim();
  expect(moveTarget).toBeTruthy();
  await moveButton.click();
  await expect(page.getByText(moveTarget!, {exact: true}).first()).toBeVisible();
  await assertPageQuality(page, testInfo);

  await page.goto('/settings');
  const spendCap = page.getByLabel('Monthly spend cap (CAD)');
  await spendCap.fill('0');
  await expect(spendCap).toHaveAttribute('aria-invalid', 'true');
  await spendCap.fill('25.00');
  await expect(spendCap).toHaveAttribute('aria-invalid', 'false');
  await page.locator('select[aria-label="Language"]:visible').selectOption('fr');
  await expect(page.getByRole('heading', {name: 'Paramètres'})).toBeVisible();
  await assertPageQuality(page, testInfo);

  await context.clearCookies();
  await context.addCookies([{
    name: 'voice-receptionist-demo-session',
    value: 'staff',
    url: testInfo.project.use.baseURL as string,
    httpOnly: true,
    sameSite: 'Lax',
  }, {
    name: 'locale',
    value: 'en',
    url: testInfo.project.use.baseURL as string,
    sameSite: 'Lax',
  }]);
  await page.goto('/settings');
  await expect(page.getByRole('button', {name: 'Send invitation'})).toHaveCount(0);
  await assertPageQuality(page, testInfo);
  const forbiddenBilling = await page.request.post('/api/billing/checkout', {data: {plan: 'starter'}});
  expect(forbiddenBilling.status()).toBe(403);
  const forbiddenNumber = await page.request.post('/api/telnyx/numbers/search', {
    data: {restaurantId, areaCode: '416', limit: 1},
  });
  expect(forbiddenNumber.status()).toBe(403);
  const adminResponse = await page.goto('/admin');
  expect(adminResponse?.status()).toBe(404);
  // The 404 document load is the behaviour under test; Chromium logs it as a console error.
  consoleErrors.get(page)?.splice(0);
});
