import {beforeSend} from '@/lib/security/redaction';

export const sentryEdgeOptions = process.env.SENTRY_DSN
  ? {dsn: process.env.SENTRY_DSN, beforeSend}
  : undefined;
