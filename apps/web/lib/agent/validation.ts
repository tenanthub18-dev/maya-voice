import type {Language} from '@/lib/data/types';

export interface AgentConfigurationInput {
  personaName: string;
  enabledLanguages: Language[];
  primaryLanguage: Language;
  transferPhone: string;
  transferStart: string;
  transferEnd: string;
  slotMinutes: number;
  coversPerSlot: number;
  seatingMinutes: number;
  maxParty: number;
  leadTimeMinutes: number;
  bookingWindowDays: number;
}

export type AgentValidationError = 'PERSONA_REQUIRED' | 'LANGUAGE_REQUIRED' | 'PRIMARY_LANGUAGE_DISABLED' | 'PHONE_INVALID' | 'TRANSFER_HOURS_INVALID' | 'BOOKING_RULES_INVALID';

export function validateE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export function validateTimeRange(start: string, end: string): boolean {
  const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return pattern.test(start) && pattern.test(end) && start < end;
}

export function validateAgentConfiguration(input: AgentConfigurationInput): AgentValidationError[] {
  const errors: AgentValidationError[] = [];
  if (!input.personaName.trim()) errors.push('PERSONA_REQUIRED');
  if (!input.enabledLanguages.length) errors.push('LANGUAGE_REQUIRED');
  if (!input.enabledLanguages.includes(input.primaryLanguage)) errors.push('PRIMARY_LANGUAGE_DISABLED');
  if (!validateE164(input.transferPhone)) errors.push('PHONE_INVALID');
  if (!validateTimeRange(input.transferStart, input.transferEnd)) errors.push('TRANSFER_HOURS_INVALID');
  const positiveIntegers = [input.slotMinutes, input.coversPerSlot, input.seatingMinutes, input.maxParty, input.bookingWindowDays];
  if (positiveIntegers.some((value) => !Number.isSafeInteger(value) || value <= 0) || !Number.isSafeInteger(input.leadTimeMinutes) || input.leadTimeMinutes < 0) errors.push('BOOKING_RULES_INVALID');
  return errors;
}

export function validateKnowledgeEntry(input: {title: string; content: string; priceCents?: number}): Array<'TITLE_REQUIRED' | 'CONTENT_REQUIRED' | 'PRICE_INVALID'> {
  const errors: Array<'TITLE_REQUIRED' | 'CONTENT_REQUIRED' | 'PRICE_INVALID'> = [];
  if (!input.title.trim()) errors.push('TITLE_REQUIRED');
  if (!input.content.trim()) errors.push('CONTENT_REQUIRED');
  if (input.priceCents !== undefined && (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0)) errors.push('PRICE_INVALID');
  return errors;
}
