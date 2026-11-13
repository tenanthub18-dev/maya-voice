import {getDataSource} from '@/lib/data';
import type {FeatureFlag, FeatureFlagKey} from '@/lib/data/types';

export type {FeatureFlagKey} from '@/lib/data/types';

export interface FeatureFlagReader {
  listFeatureFlags(): Promise<FeatureFlag[]>;
}

export async function isFlagEnabled(
  key: FeatureFlagKey,
  restaurantId: string,
  reader: FeatureFlagReader = getDataSource() as FeatureFlagReader,
): Promise<boolean> {
  const flags = await reader.listFeatureFlags();
  const restaurant = flags.find((flag) => flag.key === key && flag.restaurantId === restaurantId);
  if (restaurant) return restaurant.enabled;
  return flags.find((flag) => flag.key === key && flag.restaurantId === null)?.enabled ?? false;
}
