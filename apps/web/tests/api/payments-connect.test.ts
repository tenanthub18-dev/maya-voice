import {describe, expect, it, vi} from 'vitest';

import {createPaymentConnectHandler, type PaymentConnectDependencies} from '@/app/api/payments/connect/_lib';

const owner = {id: 'owner-1', email: 'owner@example.com', role: 'owner' as const, organizationId: 'org-1'};

function dependencies(options: {enabled?: boolean; accountId?: string | null; ready?: boolean} = {}) {
  let accountId = options.accountId ?? null;
  const repository = {
    getRestaurantPaymentConnection: vi.fn(async () => ({restaurantId: 'rest-1', connectedAccountId: accountId})),
    setRestaurantConnectedAccount: vi.fn(async (_restaurantId: string, value: string | null) => { accountId = value; }),
  };
  const stripe = {
    createStandardAccount: vi.fn(async () => ({id: 'acct_123'})),
    createAccountOnboardingLink: vi.fn(async (
      input: {accountId: string; refreshUrl: string; returnUrl: string},
      options: {idempotencyKey: string},
    ) => {
      void input;
      void options;
      return {url: 'https://connect.stripe.test/onboard'};
    }),
    retrieveAccount: vi.fn(async () => ({
      charges_enabled: options.ready ?? false,
      details_submitted: options.ready ?? false,
      payouts_enabled: options.ready ?? false,
    })),
  };
  const deps: PaymentConnectDependencies = {
    authorize: async () => ({ok: true as const, user: owner}),
    isEnabled: async () => options.enabled ?? true,
    repository,
    stripe,
    appUrl: 'https://app.test',
  };
  return {deps, repository, stripe};
}

describe('Stripe connection settings API', () => {
  it('refuses every method with typed feature_disabled while the flag is off', async () => {
    const {deps, stripe} = dependencies({enabled: false});
    const handlers = createPaymentConnectHandler(deps);

    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await handlers[method as 'GET'](new Request('https://app.test/api/payments/connect', {method}));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({error: {code: 'feature_disabled', message: 'Diner payments are disabled'}});
    }
    expect(stripe.createStandardAccount).not.toHaveBeenCalled();
  });

  it('creates one Standard account, stores it, and returns its onboarding URL', async () => {
    const {deps, repository, stripe} = dependencies();
    const response = await createPaymentConnectHandler(deps).POST(
      new Request('https://app.test/api/payments/connect', {method: 'POST'}),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({status: 'pending', url: 'https://connect.stripe.test/onboard'});
    expect(repository.setRestaurantConnectedAccount).toHaveBeenCalledWith('rest-1', 'acct_123');
    expect(stripe.createStandardAccount).toHaveBeenCalledWith({restaurantId: 'rest-1'}, {idempotencyKey: 'connect-account:rest-1'});
  });

  it('uses a fresh key for each single-use Account Link', async () => {
    const {deps, stripe} = dependencies({accountId: 'acct_123'});
    let now = 1_700_000_000;
    deps.nowSeconds = () => now++;
    const handler = createPaymentConnectHandler(deps).POST;
    await handler(new Request('https://app.test/api/payments/connect', {method: 'POST'}));
    await handler(new Request('https://app.test/api/payments/connect', {method: 'POST'}));
    expect(stripe.createAccountOnboardingLink.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      'connect-link:rest-1:acct_123:1700000000',
      'connect-link:rest-1:acct_123:1700000001',
    ]);
  });

  it.each([
    [false, 'pending'],
    [true, 'ready'],
  ] as const)('maps connected account readiness to %s => %s', async (ready, status) => {
    const {deps} = dependencies({accountId: 'acct_123', ready});
    const response = await createPaymentConnectHandler(deps).GET(
      new Request('https://app.test/api/payments/connect'),
    );
    await expect(response.json()).resolves.toEqual({status, connectedAccountId: 'acct_123'});
  });

  it('disconnects locally without deleting the restaurant Stripe account', async () => {
    const {deps, repository} = dependencies({accountId: 'acct_123'});
    const response = await createPaymentConnectHandler(deps).DELETE(
      new Request('https://app.test/api/payments/connect', {method: 'DELETE'}),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({status: 'not_connected'});
    expect(repository.setRestaurantConnectedAccount).toHaveBeenCalledWith('rest-1', null);
  });
});
