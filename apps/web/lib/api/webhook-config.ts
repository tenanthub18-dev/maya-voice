type Environment = Readonly<Record<string, string | undefined>>;

export function webhookCredential(
  name: string,
  mockValue: string,
  env: Environment = process.env,
): string {
  const configured = env[name];
  if (configured) return configured;
  if ((env.INTEGRATIONS_MODE ?? 'mock') === 'mock' && env.NODE_ENV !== 'production') {
    return mockValue;
  }
  throw new Error(`${name} is required`);
}
