import { describe, expect, it } from "vitest";

import {
  getIntegrationsMode,
  getProviderBaseUrl,
} from "@/lib/integrations/mode";

describe("integration mode", () => {
  it("defaults to mock and points providers at the dev-only route namespace", () => {
    expect(getIntegrationsMode({})).toBe("mock");
    expect(getProviderBaseUrl("telnyx", {})).toBe(
      "http://localhost:3000/api/_mock/telnyx",
    );
  });

  it("uses a configurable mock origin", () => {
    expect(
      getProviderBaseUrl("stripe", {
        INTEGRATIONS_MODE: "mock",
        INTEGRATIONS_MOCK_ORIGIN: "http://127.0.0.1:4317/",
      }),
    ).toBe("http://127.0.0.1:4317/api/_mock/stripe");
  });

  it("requires a provider base URL in live mode", () => {
    expect(() =>
      getProviderBaseUrl("resend", { INTEGRATIONS_MODE: "live" }),
    ).toThrow("RESEND_BASE_URL");
    expect(
      getProviderBaseUrl("resend", {
        INTEGRATIONS_MODE: "live",
        RESEND_BASE_URL: "https://api.resend.com/",
      }),
    ).toBe("https://api.resend.com");
  });

  it("rejects an invalid mode", () => {
    expect(() => getIntegrationsMode({ INTEGRATIONS_MODE: "staging" })).toThrow(
      "INTEGRATIONS_MODE",
    );
  });
});
