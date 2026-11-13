import {beforeSend} from '@/lib/security/redaction';

export const sentryClientOptions = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? {dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, beforeSend}
  : undefined;
