import {createApiRepository} from '@/lib/api/supabase';
import {createRetentionHandler} from './_lib';

export async function GET(request: Request): Promise<Response> {
  return createRetentionHandler({
    cronSecret: process.env.CRON_SECRET ?? '',
    repository: createApiRepository(),
  })(request);
}

export const POST = GET;
