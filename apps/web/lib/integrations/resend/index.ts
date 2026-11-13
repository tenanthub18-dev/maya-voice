import {createHmac, timingSafeEqual} from "node:crypto";
import {z} from "zod";

import {requestJson} from "../http";

export const resendSendEmailResponseSchema = z.object({id: z.string()}).passthrough();

export interface ResendClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface SendEmailInput {
  from: string;
  to: string | readonly string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | readonly string[];
  bcc?: string | readonly string[];
  replyTo?: string;
  headers?: Readonly<Record<string, string>>;
  tags?: ReadonlyArray<Readonly<{name: string; value: string}>>;
}

export function createResendClient(options: ResendClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  return {
    // https://resend.com/docs/api-reference/emails/send-email
    sendEmail(input: SendEmailInput, requestOptions: {idempotencyKey: string}) {
      return requestJson({
        provider: "resend",
        url: `${baseUrl}/emails`,
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: input.from,
          to: input.to,
          subject: input.subject,
          ...(input.text === undefined ? {} : {text: input.text}),
          ...(input.html === undefined ? {} : {html: input.html}),
          ...(input.cc === undefined ? {} : {cc: input.cc}),
          ...(input.bcc === undefined ? {} : {bcc: input.bcc}),
          ...(input.replyTo === undefined ? {} : {reply_to: input.replyTo}),
          ...(input.headers === undefined ? {} : {headers: input.headers}),
          ...(input.tags === undefined ? {} : {tags: input.tags}),
        }),
        idempotencyKey: requestOptions.idempotencyKey,
        schema: resendSendEmailResponseSchema,
        timeoutMs: options.timeoutMs,
        fetchFn: options.fetch,
      });
    },
  };
}

export interface ResendWebhookVerificationInput {
  rawBody: string | Uint8Array;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

function decodeSecret(secret: string): Buffer | undefined {
  try {
    const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const decoded = Buffer.from(encoded, "base64url");
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function equalBase64(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, "base64");
    const rightBytes = Buffer.from(right, "base64");
    return leftBytes.length > 0 && leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

// https://resend.com/docs/webhooks/verify-webhooks-requests
// Svix signing format: https://docs.svix.com/receiving/verifying-payloads/how-manual
export function verifyResendWebhook(input: ResendWebhookVerificationInput): boolean {
  const timestamp = Number(input.svixTimestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) {
    return false;
  }
  const key = decodeSecret(input.secret);
  if (key === undefined) return false;
  const body = typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody);
  const signed = Buffer.concat([
    Buffer.from(`${input.svixId}.${input.svixTimestamp}.`),
    Buffer.from(body),
  ]);
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  return input.svixSignature
    .split(/\s+/u)
    .filter((part) => part.startsWith("v1,"))
    .some((part) => equalBase64(expected, part.slice(3)));
}
