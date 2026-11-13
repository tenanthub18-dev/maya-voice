import {describe, expect, it} from 'vitest';
import {diffPromptSections} from '@/lib/agent/diff';
import {validateAgentConfiguration, validateE164, validateKnowledgeEntry} from '@/lib/agent/validation';

describe('agent prompt version diff', () => {
  it('returns only added, changed and removed sections in stable key order', () => {
    expect(diffPromptSections(
      {greeting: 'Hello', menu: 'Old menu', unchanged: 'Same'},
      {greeting: 'Welcome', policies: 'No outside food', unchanged: 'Same'}
    )).toEqual([
      {key: 'greeting', before: 'Hello', after: 'Welcome', change: 'changed'},
      {key: 'menu', before: 'Old menu', after: '', change: 'removed'},
      {key: 'policies', before: '', after: 'No outside food', change: 'added'}
    ]);
  });
});

describe('agent configuration validation', () => {
  it('accepts E.164 phone numbers and rejects local or malformed values', () => {
    expect(validateE164('+14165550123')).toBe(true);
    expect(validateE164('4165550123')).toBe(false);
    expect(validateE164('+0123')).toBe(false);
  });

  it('reports every invalid rule without discarding valid fields', () => {
    expect(validateAgentConfiguration({
      personaName: ' ',
      enabledLanguages: [],
      primaryLanguage: 'fr-CA',
      transferPhone: '4165550123',
      transferStart: '22:00',
      transferEnd: '10:00',
      slotMinutes: 0,
      coversPerSlot: -1,
      seatingMinutes: 0,
      maxParty: 0,
      leadTimeMinutes: -1,
      bookingWindowDays: 0
    })).toEqual([
      'PERSONA_REQUIRED', 'LANGUAGE_REQUIRED', 'PRIMARY_LANGUAGE_DISABLED', 'PHONE_INVALID',
      'TRANSFER_HOURS_INVALID', 'BOOKING_RULES_INVALID'
    ]);
  });

  it('validates knowledge text and prices at the domain boundary', () => {
    expect(validateKnowledgeEntry({title: '', content: 'Answer', priceCents: 100})).toEqual(['TITLE_REQUIRED']);
    expect(validateKnowledgeEntry({title: 'Lunch', content: '', priceCents: -1})).toEqual(['CONTENT_REQUIRED', 'PRICE_INVALID']);
    expect(validateKnowledgeEntry({title: 'Lunch', content: 'Served daily', priceCents: 0})).toEqual([]);
  });
});
