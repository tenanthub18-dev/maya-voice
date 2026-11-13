import { describe, expect, it } from "vitest";

import {
  checkEnv,
  findMissingEnv,
  parseRequiredNames,
} from "../../../scripts/check-env";

describe("parseRequiredNames", () => {
  it("ignores comment lines", () => {
    expect(parseRequiredNames("# Supabase\nSUPABASE_URL=\n")).toEqual([
      "SUPABASE_URL",
    ]);
  });

  it("ignores lines without an equals sign", () => {
    expect(parseRequiredNames("SUPABASE_URL\nSONIOX_API_KEY=\n")).toEqual([
      "SONIOX_API_KEY",
    ]);
  });
});

describe("findMissingEnv", () => {
  it("returns required names whose injected values are absent or empty", () => {
    const requiredNames = ["SUPABASE_URL", "SONIOX_API_KEY", "WORKER_URL"];
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SONIOX_API_KEY: "",
    };

    expect(findMissingEnv(requiredNames, env)).toEqual([
      "SONIOX_API_KEY",
      "WORKER_URL",
    ]);
  });
});

describe("checkEnv", () => {
  it("allows integration credentials to be absent in mock mode", () => {
    const contents =
      "INTEGRATIONS_MODE=mock\nTELNYX_BASE_URL=https://api.telnyx.com/v2\nTELNYX_API_KEY=\nSTRIPE_SECRET_KEY=\n";

    expect(checkEnv({ INTEGRATIONS_MODE: "mock" }, contents)).toEqual([]);
  });

  it("accepts a live environment that selects the supabase data source", () => {
    const contents = "INTEGRATIONS_MODE=mock\nTELNYX_API_KEY=\n";

    expect(
      checkEnv({ INTEGRATIONS_MODE: "live", TELNYX_API_KEY: "key", DATA_SOURCE: "supabase" }, contents),
    ).toEqual([]);
  });

  it("requires integration credentials in live mode", () => {
    const contents =
      "INTEGRATIONS_MODE=mock\nTELNYX_BASE_URL=https://api.telnyx.com/v2\nTELNYX_API_KEY=\nSTRIPE_SECRET_KEY=\nGEMINI_MODEL_ID=\nSONIOX_TTS_MODEL_ID=\nSONIOX_TTS_PATH=\n";

    expect(checkEnv({ INTEGRATIONS_MODE: "live" }, contents)).toEqual([
      "TELNYX_BASE_URL",
      "TELNYX_API_KEY",
      "STRIPE_SECRET_KEY",
      "GEMINI_MODEL_ID",
      "SONIOX_TTS_MODEL_ID",
      "SONIOX_TTS_PATH",
      "DATA_SOURCE",
    ]);
  });

  it("treats route-specific provider secrets as optional only in mock mode", () => {
    const contents = [
      "INTEGRATIONS_MODE=mock",
      "SUPABASE_SERVICE_ROLE_KEY=",
      "TELNYX_PUBLIC_KEY=",
      "TELNYX_TEXML_APP_ID=",
      "TELNYX_MESSAGING_PROFILE_ID=",
      "STRIPE_WEBHOOK_SECRET=",
      "RESEND_WEBHOOK_SECRET=",
      "FIRECRAWL_API_KEY=",
      "GEMINI_API_KEY=",
    ].join("\n");

    expect(checkEnv({INTEGRATIONS_MODE: "mock"}, contents)).toEqual([]);
    expect(checkEnv({INTEGRATIONS_MODE: "live"}, contents)).toEqual([
      "SUPABASE_SERVICE_ROLE_KEY",
      "TELNYX_PUBLIC_KEY",
      "TELNYX_TEXML_APP_ID",
      "TELNYX_MESSAGING_PROFILE_ID",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_WEBHOOK_SECRET",
      "FIRECRAWL_API_KEY",
      "GEMINI_API_KEY",
      "DATA_SOURCE",
    ]);
  });
});
