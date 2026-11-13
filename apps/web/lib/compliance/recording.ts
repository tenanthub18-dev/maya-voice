import type {CanadianProvince} from '@/lib/data/types';

export type RecordingNoticeLanguage = 'en' | 'fr';
export const RECORDING_NOTICE_EN = 'This call may be recorded to help us serve you. By continuing, you consent to the recording. You may ask us to continue without recording.';
export const RECORDING_NOTICE_FR = 'Cet appel peut être enregistré afin de mieux vous servir. En poursuivant, vous consentez à l’enregistrement. Vous pouvez nous demander de continuer sans enregistrer l’appel.';

// The OPC requires notice of recording, its purpose, consent, and a recording-free
// alternative when recording is not integral to the service.
// https://www.priv.gc.ca/en/privacy-topics/surveillance/02_05_d_14/
export function recordingLanguageOrder(province: CanadianProvince): readonly RecordingNoticeLanguage[] {
  return province === 'QC' ? ['fr', 'en'] : ['en', 'fr'];
}

export function hasMandatoryRecordingDisclosure(notice: string, province: CanadianProvince): boolean {
  const first = province === 'QC' ? RECORDING_NOTICE_FR : RECORDING_NOTICE_EN;
  const second = province === 'QC' ? RECORDING_NOTICE_EN : RECORDING_NOTICE_FR;
  const firstIndex = notice.indexOf(first);
  const secondIndex = notice.indexOf(second);
  return firstIndex >= 0 && secondIndex > firstIndex;
}
