import type {DataSource} from './types';
import {createMockDataSource} from './mock';
import {createSupabaseDataSource} from './supabase';

let mockSource: DataSource | undefined;

export function isDemoData(): boolean {
  return (process.env.DATA_SOURCE ?? 'mock') === 'mock';
}

export function getDataSource(): DataSource {
  const selection = process.env.DATA_SOURCE ?? 'mock';
  if (selection === 'mock') return (mockSource ??= createMockDataSource());
  if (selection === 'supabase') {
    return createSupabaseDataSource(async () => {
      const {createServerSupabaseClient} = await import('./supabase/server');
      return createServerSupabaseClient();
    });
  }
  throw new Error(`Unsupported DATA_SOURCE: ${selection}`);
}

export type * from './types';
