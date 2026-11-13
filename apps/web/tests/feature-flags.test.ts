import {describe, expect, it} from 'vitest';

import {isFlagEnabled, type FeatureFlagReader} from '@/lib/feature-flags';

describe('feature flags', () => {
  it('prefers the restaurant override, then global value, and otherwise defaults false', async () => {
    const reader: FeatureFlagReader = {
      listFeatureFlags: async () => [
        {id: 'global', key: 'diner_payments', restaurantId: null, enabled: true, updatedBy: 'admin', updatedAt: '2026-10-27T00:00:00.000Z'},
        {id: 'restaurant', key: 'diner_payments', restaurantId: 'restaurant-1', enabled: false, updatedBy: 'admin', updatedAt: '2026-10-27T00:00:00.000Z'},
      ],
    };

    await expect(isFlagEnabled('diner_payments', 'restaurant-1', reader)).resolves.toBe(false);
    await expect(isFlagEnabled('diner_payments', 'restaurant-2', reader)).resolves.toBe(true);
    await expect(isFlagEnabled('diner_payments', 'restaurant-2', {listFeatureFlags: async () => []})).resolves.toBe(false);
  });
});
