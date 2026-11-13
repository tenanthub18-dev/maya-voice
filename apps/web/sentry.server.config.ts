import {beforeSend} from '@/lib/security/redaction';

export const sentryServerOptions = process.env.SENTRY_DSN
  ? {dsn: process.env.SENTRY_DSN, beforeSend}
  : undefined;
