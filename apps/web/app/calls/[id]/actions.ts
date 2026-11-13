'use server';

import {requireActionCapability} from '@/lib/auth/guards';
import {getDataSource, type Language} from '@/lib/data';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import {assertStrictFormData} from '@/lib/security/actions';

const languages = new Set<Language>(['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar']);

export async function saveTeaching(_saved: boolean, formData: FormData): Promise<boolean> {
  assertStrictFormData(formData, ['callId', 'question', 'answer', 'language']);
  await requireActionCapability('publishAgent');
  const callId = String(formData.get('callId') ?? '');
  const question = String(formData.get('question') ?? '').trim();
  const answer = String(formData.get('answer') ?? '').trim();
  const rawLanguage = String(formData.get('language') ?? '');
  if (!callId || !question || !answer || !languages.has(rawLanguage as Language)) throw new Error('Invalid teaching submission');
  await getDataSource().createFaq({question, answer, language: rawLanguage as Language, source: 'teach'});
  await invalidateAfterWrite();
  return true;
}
