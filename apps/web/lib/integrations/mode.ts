export type IntegrationMode = "mock" | "live";
export type Provider =
  | "telnyx"
  | "stripe"
  | "resend"
  | "firecrawl"
  | "gemini"
  | "soniox";

export type Environment = Readonly<Record<string, string | undefined>>;

const providerEnvironmentNames: Record<Provider, string> = {
  telnyx: "TELNYX_BASE_URL",
  stripe: "STRIPE_BASE_URL",
  resend: "RESEND_BASE_URL",
  firecrawl: "FIRECRAWL_BASE_URL",
  gemini: "GEMINI_BASE_URL",
  soniox: "SONIOX_BASE_URL",
};

export function getIntegrationsMode(env: Environment = process.env): IntegrationMode {
  const value = env.INTEGRATIONS_MODE ?? "mock";
  if (value !== "mock" && value !== "live") {
    throw new Error("INTEGRATIONS_MODE must be either mock or live");
  }
  return value;
}

const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/u, "");

export function getProviderBaseUrl(
  provider: Provider,
  env: Environment = process.env,
): string {
  if (getIntegrationsMode(env) === "mock") {
    const origin = withoutTrailingSlash(
      env.INTEGRATIONS_MOCK_ORIGIN ?? "http://localhost:3000",
    );
    return `${origin}/api/_mock/${provider}`;
  }

  const name = providerEnvironmentNames[provider];
  const value = env[name];
  if (!value) throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
  return withoutTrailingSlash(value);
}
