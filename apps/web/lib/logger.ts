import {safeLogger} from '@/lib/security/redaction';

export const webLogger = {
  error: safeLogger(console.error.bind(console)).error,
  info: safeLogger(console.info.bind(console)).info,
  warn: safeLogger(console.warn.bind(console)).warn,
};
