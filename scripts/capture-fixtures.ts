import {lstat, mkdir, realpath, writeFile} from "node:fs/promises";
import {dirname, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

type Provider = "telnyx" | "stripe" | "resend" | "firecrawl" | "gemini" | "soniox";
type Json = null | boolean | number | string | Json[] | {[key: string]: Json};

const providers = new Set<Provider>([
  "telnyx",
  "stripe",
  "resend",
  "firecrawl",
  "gemini",
  "soniox",
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveFixturesRoot = resolve(repositoryRoot, "docs/api");
const allowedHosts: Readonly<Record<Provider, string>> = {
  telnyx: "api.telnyx.com",
  stripe: "api.stripe.com",
  resend: "api.resend.com",
  firecrawl: "api.firecrawl.dev",
  gemini: "generativelanguage.googleapis.com",
  soniox: "api.soniox.com",
};
const sensitiveKey = /(?:^|[_-])(?:authorization|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|signature)(?:$|[_-])/iu;
const phoneKey = /^(?:phone|phones|phone_number|phone_numbers|telephone|telephone_number|contact_number|contact_phone|mobile|fax|caller|callee)$/iu;
const internationalPhone = /\+[1-9][0-9](?:[ .()-]?[0-9]){6,14}(?:\s*(?:x|ext\.?|extension)\s*[0-9]{1,8})?/giu;
const northAmericanPhone = /(?<![0-9])(?:\+?1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?:\s*(?:x|ext\.?|extension)\s*[0-9]{1,8})?(?![0-9])/giu;
const localPhone = /(?<![0-9])[2-9][0-9]{2}[ .-][0-9]{4}(?:\s*(?:x|ext\.?|extension)\s*[0-9]{1,8})?(?![0-9])/giu;
const recognizableSecret = /\b(?:sk_(?:live|test)_[A-Za-z0-9]+|pk_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9_-]{12,}|fc-[A-Za-z0-9_-]{12,})\b/gu;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function providerArgument(argv: readonly string[]): Provider {
  const inline = argv.find((argument) => argument.startsWith("--provider="))?.slice("--provider=".length);
  const index = argv.indexOf("--provider");
  const value = inline ?? (index === -1 ? undefined : argv[index + 1]);
  if (!value || !providers.has(value as Provider)) {
    throw new Error(`Use --provider ${[...providers].join("|")}`);
  }
  return value as Provider;
}

function baseUrl(provider: Provider): string {
  const value = required(`${provider.toUpperCase()}_BASE_URL`).replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider.toUpperCase()}_BASE_URL must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== allowedHosts[provider] ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`${provider.toUpperCase()}_BASE_URL must use https://${allowedHosts[provider]}`);
  }
  return value;
}

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => sensitiveKey.test(name) && Boolean(value) && value!.length >= 4)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED_SECRET]");
  return redacted
    .replace(recognizableSecret, "[REDACTED_SECRET]")
    .replace(internationalPhone, "[REDACTED_PHONE]")
    .replace(northAmericanPhone, "[REDACTED_PHONE]")
    .replace(localPhone, "[REDACTED_PHONE]");
}

export function sanitize(value: Json, secrets = secretValues()): Json {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, secrets));
  if (value === null || typeof value !== "object") return value;

  const sanitized: {[key: string]: Json} = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    const key = redactText(rawKey, secrets);
    if (sensitiveKey.test(rawKey)) sanitized[key] = "[REDACTED_SECRET]";
    else if (phoneKey.test(rawKey)) sanitized[key] = "[REDACTED_PHONE]";
    else sanitized[key] = sanitize(entry, secrets);
  }
  return sanitized;
}

async function requestJson(url: string, init: RequestInit): Promise<Json> {
  const response = await fetch(url, {...init, redirect: "error"});
  if (!response.ok) throw new Error(`Live endpoint returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new Error("Live endpoint did not return JSON");
  }
  return await response.json() as Json;
}

function requirePaidCapture(provider: "firecrawl" | "gemini"): void {
  if (process.env.LIVE_SMOKE_ALLOW_MUTATIONS !== "1") {
    throw new Error(`${provider} capture consumes provider quota; set LIVE_SMOKE_ALLOW_MUTATIONS=1`);
  }
}

async function capture(provider: Provider): Promise<Readonly<{name: string; body: Json}>> {
  switch (provider) {
    case "telnyx": {
      // https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers
      const url = new URL(`${baseUrl(provider)}/available_phone_numbers`);
      url.searchParams.set("filter[country_code]", "CA");
      url.searchParams.set("filter[national_destination_code]", process.env.LIVE_SMOKE_AREA_CODE ?? "416");
      url.searchParams.set("filter[phone_number_type]", "local");
      url.searchParams.set("filter[limit]", "1");
      return {
        name: "available-phone-numbers",
        body: await requestJson(url.toString(), {headers: {Authorization: `Bearer ${required("TELNYX_API_KEY")}`}}),
      };
    }
    case "stripe": {
      // https://docs.stripe.com/api/events/list
      const eventType = process.env.LIVE_CAPTURE_STRIPE_EVENT_TYPE ?? "checkout.session.completed";
      const url = new URL(`${baseUrl(provider)}/v1/events`);
      url.searchParams.set("type", eventType);
      url.searchParams.set("limit", "1");
      const authorization = Buffer.from(`${required("STRIPE_SECRET_KEY")}:`).toString("base64");
      return {
        name: `event-${eventType.replace(/[^a-z0-9.-]/giu, "-")}`,
        body: await requestJson(url.toString(), {headers: {Authorization: `Basic ${authorization}`}}),
      };
    }
    case "resend": {
      // https://resend.com/docs/api-reference/domains/list-domains
      return {
        name: "domains",
        body: await requestJson(`${baseUrl(provider)}/domains`, {
          headers: {Authorization: `Bearer ${required("RESEND_API_KEY")}`},
        }),
      };
    }
    case "firecrawl": {
      // https://docs.firecrawl.dev/api-reference/endpoint/scrape
      requirePaidCapture(provider);
      return {
        name: "scrape",
        body: await requestJson(`${baseUrl(provider)}/scrape`, {
          method: "POST",
          headers: {Authorization: `Bearer ${required("FIRECRAWL_API_KEY")}`, "Content-Type": "application/json"},
          body: JSON.stringify({url: required("LIVE_SMOKE_URL"), formats: ["markdown"], onlyMainContent: true}),
        }),
      };
    }
    case "gemini": {
      // https://ai.google.dev/api/generate-content
      requirePaidCapture(provider);
      const model = required("GEMINI_MODEL_ID");
      return {
        name: "generate-content",
        body: await requestJson(`${baseUrl(provider)}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: {"Content-Type": "application/json", "x-goog-api-key": required("GEMINI_API_KEY")},
          body: JSON.stringify({
            contents: [{role: "user", parts: [{text: "Reply with the JSON object {\"status\":\"ok\"}."}]}],
            generationConfig: {
              maxOutputTokens: 64,
              responseMimeType: "application/json",
              responseSchema: {type: "object", properties: {status: {type: "string"}}, required: ["status"]},
            },
          }),
        }),
      };
    }
    case "soniox": {
      // https://soniox.com/docs/api-reference/stt/get_models.mdx
      return {
        name: "models",
        body: await requestJson(`${baseUrl(provider)}/v1/models`, {
          headers: {Authorization: `Bearer ${required("SONIOX_API_KEY")}`},
        }),
      };
    }
  }
}

async function main(): Promise<void> {
  if (process.env.INTEGRATIONS_MODE !== "live") {
    throw new Error("Set INTEGRATIONS_MODE=live before capturing fixtures");
  }
  const provider = providerArgument(process.argv.slice(2));
  const result = await capture(provider);
  const directory = resolve(liveFixturesRoot, provider, "fixtures/live");
  const allowedPrefix = `${liveFixturesRoot}${sep}`;
  if (!directory.startsWith(allowedPrefix)) throw new Error("Refusing fixture path outside docs/api");

  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputPath = resolve(directory, `${result.name}.${timestamp}.json`);
  if (!outputPath.startsWith(`${directory}${sep}`)) throw new Error("Refusing unsafe fixture filename");
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Refusing symbolic-link fixture directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(directory, {recursive: true});
  const [realRoot, realDirectory] = await Promise.all([
    realpath(liveFixturesRoot),
    realpath(directory),
  ]);
  if (!realDirectory.startsWith(`${realRoot}${sep}`)) throw new Error("Refusing fixture directory outside docs/api");
  await writeFile(outputPath, `${JSON.stringify(sanitize(result.body), null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  process.stdout.write(`WROTE ${outputPath.replace(`${repositoryRoot}${sep}`, "")}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Fixture capture failed";
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
