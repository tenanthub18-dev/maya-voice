export type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export function assertDemoLoginAllowed(env: AuthEnvironment = process.env): void {
  if ((env.INTEGRATIONS_MODE ?? 'mock') !== 'mock') {
    throw new Error('Demo login is available only in mock mode');
  }
}

export function isMockAuth(env: AuthEnvironment = process.env): boolean {
  return (env.INTEGRATIONS_MODE ?? 'mock') === 'mock';
}
