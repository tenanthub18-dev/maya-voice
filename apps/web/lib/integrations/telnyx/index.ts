import {createPublicKey, verify} from "node:crypto";
import {z} from "zod";

import {requestJson} from "../http";

const moneySchema = z.object({amount: z.string(), currency: z.string()}).passthrough();

const availableNumberSchema = z
  .object({
    phone_number: z.string(),
    record_type: z.string(),
    features: z.array(z.object({name: z.string()}).passthrough()),
    cost_information: z
      .object({upfront_cost: z.string(), monthly_cost: z.string(), currency: z.string()})
      .passthrough(),
  })
  .passthrough();

export const telnyxSearchNumbersResponseSchema = z
  .object({data: z.array(availableNumberSchema), meta: z.record(z.string(), z.unknown()).optional()})
  .passthrough();

// VERIFY: several number-management fixtures are composed OpenAPI examples rather than captures.
const phoneNumberSchema = z
  .object({
    id: z.string(),
    record_type: z.literal("phone_number"),
    phone_number: z.string(),
    status: z.string(),
    connection_id: z.string().nullish(),
  })
  .passthrough();

export const telnyxNumberOrderResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string(),
        record_type: z.literal("number_order"),
        status: z.string(),
        phone_numbers: z.array(
          z.object({id: z.string(), phone_number: z.string(), status: z.string()}).passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

export const telnyxNumbersListResponseSchema = z
  .object({data: z.array(phoneNumberSchema), meta: z.record(z.string(), z.unknown()).optional()})
  .passthrough();

export const telnyxPhoneNumberResponseSchema = z.object({data: phoneNumberSchema}).passthrough();

export const telnyxMessageResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string(),
        record_type: z.literal("message"),
        direction: z.string(),
        from: z.object({phone_number: z.string()}).passthrough(),
        to: z.array(z.object({phone_number: z.string(), status: z.string()}).passthrough()),
        text: z.string(),
        cost: moneySchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

type Fetch = typeof fetch;

export interface TelnyxClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface SearchNumbersInput {
  areaCode: string;
  countryCode?: string;
  limit?: number;
  features?: readonly ("sms" | "voice")[];
}

export interface OrderNumberInput {
  phoneNumber: string;
  customerReference?: string;
  connectionId?: string;
  messagingProfileId?: string;
}

export interface ListNumbersInput {
  pageSize?: number;
  pageNumber?: number;
  customerReference?: string;
}

export interface SendSmsInput {
  from: string;
  to: string;
  text: string;
  messagingProfileId?: string;
}

interface IdempotentRequestOptions {
  idempotencyKey: string;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function createTelnyxClient(options: TelnyxClientOptions) {
  const baseUrl = trimSlash(options.baseUrl);
  const headers = {authorization: `Bearer ${options.apiKey}`};
  const common = {
    provider: "telnyx" as const,
    timeoutMs: options.timeoutMs,
    fetchFn: options.fetch,
  };

  return {
    // https://developers.telnyx.com/api-reference/phone-number-search/list-available-phone-numbers
    searchNumbers(input: SearchNumbersInput) {
      const url = new URL(`${baseUrl}/available_phone_numbers`);
      url.searchParams.set("filter[country_code]", input.countryCode ?? "CA");
      url.searchParams.set("filter[national_destination_code]", input.areaCode);
      url.searchParams.set("filter[phone_number_type]", "local");
      url.searchParams.set("filter[limit]", String(input.limit ?? 5));
      for (const feature of input.features ?? ["sms", "voice"]) {
        // VERIFY live: Telnyx documents deepObject+explode but not the array wire example.
        url.searchParams.append("filter[features][]", feature);
      }
      return requestJson({
        ...common,
        url: url.toString(),
        headers,
        schema: telnyxSearchNumbersResponseSchema,
        retrySafe: true,
      });
    },

    // https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order
    orderNumber(input: OrderNumberInput) {
      return requestJson({
        ...common,
        url: `${baseUrl}/number_orders`,
        method: "POST",
        headers: {...headers, "content-type": "application/json"},
        body: JSON.stringify({
          phone_numbers: [{phone_number: input.phoneNumber}],
          ...(input.customerReference === undefined
            ? {}
            : {customer_reference: input.customerReference}),
          ...(input.connectionId === undefined ? {} : {connection_id: input.connectionId}),
          ...(input.messagingProfileId === undefined
            ? {}
            : {messaging_profile_id: input.messagingProfileId}),
        }),
        schema: telnyxNumberOrderResponseSchema,
        retries: 0,
      });
    },

    // https://developers.telnyx.com/api-reference/phone-number-configurations/list-phone-numbers
    listNumbers(input: ListNumbersInput = {}) {
      const url = new URL(`${baseUrl}/phone_numbers`);
      if (input.pageSize !== undefined) url.searchParams.set("page[size]", String(input.pageSize));
      if (input.pageNumber !== undefined) url.searchParams.set("page[number]", String(input.pageNumber));
      if (input.customerReference !== undefined) {
        url.searchParams.set("filter[customer_reference]", input.customerReference);
      }
      return requestJson({
        ...common,
        url: url.toString(),
        headers,
        schema: telnyxNumbersListResponseSchema,
        retrySafe: true,
      });
    },

    // https://developers.telnyx.com/api-reference/phone-number-configurations/delete-a-phone-number
    releaseNumber(id: string) {
      return requestJson({
        ...common,
        url: `${baseUrl}/phone_numbers/${encodeURIComponent(id)}`,
        method: "DELETE",
        headers,
        schema: telnyxPhoneNumberResponseSchema,
        retries: 0,
      });
    },

    // https://developers.telnyx.com/api-reference/phone-number-configurations/update-a-phone-number
    assignToTeXmlApp(id: string, connectionId: string) {
      // VERIFY live: Telnyx does not explicitly state that a TeXML application id is this connection_id.
      return requestJson({
        ...common,
        url: `${baseUrl}/phone_numbers/${encodeURIComponent(id)}`,
        method: "PATCH",
        headers: {...headers, "content-type": "application/json"},
        body: JSON.stringify({connection_id: connectionId}),
        schema: telnyxPhoneNumberResponseSchema,
        retries: 0,
      });
    },

    // https://developers.telnyx.com/api-reference/messages/send-a-message
    sendSms(input: SendSmsInput, requestOptions: IdempotentRequestOptions) {
      return requestJson({
        ...common,
        url: `${baseUrl}/messages`,
        method: "POST",
        headers: {...headers, "content-type": "application/json"},
        body: JSON.stringify({
          from: input.from,
          to: input.to,
          text: input.text,
          ...(input.messagingProfileId === undefined
            ? {}
            : {messaging_profile_id: input.messagingProfileId}),
        }),
        idempotencyKey: requestOptions.idempotencyKey,
        schema: telnyxMessageResponseSchema,
      });
    },
  };
}

export interface TelnyxWebhookVerificationInput {
  rawBody: string | Uint8Array;
  signature: string;
  timestamp: string;
  publicKey: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
export function verifyTelnyxWebhook(input: TelnyxWebhookVerificationInput): boolean {
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) return false;
  try {
    const rawKey = Buffer.from(input.publicKey, "base64");
    if (rawKey.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
    const rawBody = typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody);
    const signed = Buffer.concat([Buffer.from(`${input.timestamp}|`), Buffer.from(rawBody)]);
    return verify(null, signed, key, Buffer.from(input.signature, "base64"));
  } catch {
    return false;
  }
}
