import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

type Environment = Readonly<Record<string, string | undefined>>;
type Provider =
  | "Application"
  | "Firecrawl"
  | "Gemini"
  | "Resend"
  | "Soniox"
  | "Stripe"
  | "Supabase"
  | "Telnyx";

const optionalNames = new Set([
  "DATA_SOURCE",
  "LATENCY_JSONL_PATH",
  "TELNYX_TEXML_REQUIRE_SIGNATURE",
  "TELNYX_TEXML_WEBHOOK_SECRET",
  "INTEGRATIONS_MODE",
  "INTEGRATIONS_MOCK_ORIGIN",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "TRANSFER_PHONE_FALLBACK",
]);
const integrationNames = new Set([
  "SUPABASE_SECRET_KEY",
  "TEST_CALL_HMAC_SECRET",
  "PRIVACY_REQUEST_HASH_SECRET",
  "SONIOX_HEALTHCHECK_URL",
  "GEMINI_HEALTHCHECK_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "TELNYX_BASE_URL",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  "TELNYX_TEXML_APP_ID",
  "TELNYX_MESSAGING_PROFILE_ID",
  "STRIPE_BASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_GROWTH_PRICE_ID",
  "STRIPE_METERED_PRICE_ID",
  "RESEND_BASE_URL",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "RESEND_FROM_EMAIL",
  "CRON_SECRET",
  "FIRECRAWL_BASE_URL",
  "FIRECRAWL_API_KEY",
  "GEMINI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL_ID",
  "SONIOX_BASE_URL",
  "SONIOX_API_KEY",
  "SONIOX_TTS_MODEL_ID",
  "SONIOX_TTS_PATH",
  "SONIOX_VOICE_ID",
]);

const examplePath = fileURLToPath(new URL("../.env.example", import.meta.url));

const providerPrefixes: ReadonlyArray<readonly [string, Provider]> = [
  ["NEXT_PUBLIC_SUPABASE_", "Supabase"],
  ["NEXT_PUBLIC_STRIPE_", "Stripe"],
  ["SUPABASE_", "Supabase"],
  ["TELNYX_", "Telnyx"],
  ["STRIPE_", "Stripe"],
  ["RESEND_", "Resend"],
  ["FIRECRAWL_", "Firecrawl"],
  ["GEMINI_", "Gemini"],
  ["SONIOX_", "Soniox"],
];

export const liveRequiredNames = [
  "NEXT_PUBLIC_APP_URL",
  "WORKER_BASE_URL",
  "TEST_CALL_HMAC_SECRET",
  "PRIVACY_REQUEST_HASH_SECRET",
  "CRON_SECRET",
  "WS_AUTH_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "TELNYX_BASE_URL",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  "TELNYX_TEXML_APP_ID",
  "TELNYX_MESSAGING_PROFILE_ID",
  "STRIPE_BASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_GROWTH_PRICE_ID",
  "STRIPE_METERED_PRICE_ID",
  "RESEND_BASE_URL",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "RESEND_FROM_EMAIL",
  "FIRECRAWL_BASE_URL",
  "FIRECRAWL_API_KEY",
  "GEMINI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL_ID",
  "GEMINI_HEALTHCHECK_URL",
  "SONIOX_BASE_URL",
  "SONIOX_API_KEY",
  "SONIOX_TTS_MODEL_ID",
  "SONIOX_TTS_PATH",
  "SONIOX_VOICE_ID",
  "SONIOX_HEALTHCHECK_URL",
] as const;

export function parseRequiredNames(contents: string): string[] {
  return contents
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")));
}

export function findMissingEnv(
  requiredNames: readonly string[],
  env: Environment,
): string[] {
  return requiredNames.filter((name) => !env[name]);
}

export function checkEnv(
  env: Environment,
  exampleContents = readFileSync(examplePath, "utf8"),
  additionalRequiredNames: readonly string[] = [],
): string[] {
  const mode = env.INTEGRATIONS_MODE ?? "mock";
  if (mode !== "mock" && mode !== "live") {
    return ["INTEGRATIONS_MODE"];
  }
  const requiredNames = [
    ...new Set([...parseRequiredNames(exampleContents), ...additionalRequiredNames]),
  ].filter(
    (name) =>
      !optionalNames.has(name) &&
      !(mode === "mock" && integrationNames.has(name)),
  );
  const missing = findMissingEnv(requiredNames, env);
  // DATA_SOURCE defaults to mock, which would leave a live deployment on demo data.
  if (mode === "live" && env.DATA_SOURCE !== "supabase") missing.push("DATA_SOURCE");
  return missing;
}

export function providerForEnv(name: string): Provider {
  return providerPrefixes.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "Application";
}

export function formatMissingEnv(missingNames: readonly string[]): string {
  const grouped = new Map<Provider, string[]>();
  for (const name of missingNames) {
    const provider = providerForEnv(name);
    const names = grouped.get(provider) ?? [];
    names.push(name);
    grouped.set(provider, names);
  }
  return [...grouped.entries()]
    .map(([provider, names]) => `[${provider}]\n${names.map((name) => `  ${name}`).join("\n")}`)
    .join("\n");
}

function main(): void {
  const forceLive = process.argv.slice(2).includes("--live");
  const env = forceLive
    ? {...process.env, INTEGRATIONS_MODE: "live"}
    : process.env;
  const missingNames = checkEnv(env, undefined, forceLive ? liveRequiredNames : []);

  if (missingNames.length > 0) {
    console.error(formatMissingEnv(missingNames));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
