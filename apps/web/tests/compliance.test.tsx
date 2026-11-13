// @vitest-environment jsdom

import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {PrivacyRequestForm} from '@/components/privacy-request-form';
import {SettingsControls} from '@/app/settings/settings-controls';
import {hasMandatoryRecordingDisclosure, recordingLanguageOrder, RECORDING_NOTICE_EN, RECORDING_NOTICE_FR} from '@/lib/compliance/recording';
import messages from '@/messages/en.json';
import messagesFr from '@/messages/fr.json';

const restaurantId = '11111111-1111-4111-8111-111111111111';

vi.mock('@/app/settings/actions', () => ({saveNotificationPreferences: vi.fn(), saveLegalSettings: vi.fn()}));

function provider(children: React.ReactNode) {
  return render(<NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('recording notice order', () => {
  it('is French-first in Quebec and English-first elsewhere in Canada', () => {
    expect(recordingLanguageOrder('QC')).toEqual(['fr', 'en']);
    expect(recordingLanguageOrder('ON')).toEqual(['en', 'fr']);
    expect(recordingLanguageOrder('BC')).toEqual(['en', 'fr']);
  });

  it('rejects missing or incorrectly ordered mandatory recording disclosure', () => {
    expect(hasMandatoryRecordingDisclosure(`${RECORDING_NOTICE_FR}\n\n${RECORDING_NOTICE_EN}`, 'QC')).toBe(true);
    expect(hasMandatoryRecordingDisclosure(`${RECORDING_NOTICE_EN}\n\n${RECORDING_NOTICE_FR}`, 'QC')).toBe(false);
    expect(hasMandatoryRecordingDisclosure(RECORDING_NOTICE_EN, 'ON')).toBe(false);
  });

  it('renders the Quebec notice in French before the exact PRD English notice', () => {
    const view = provider(<SettingsControls
      notifications={{messageTaken: true, missedTransfer: true, flaggedCall: true, lowBalance: true, dailyDigest: false}}
      spendCapCents={20_000}
      legal={{recordingNotice: '', recordingEnabled: true, transcriptEnabled: true, legalReviewRequired: true, privacyPolicyUrl: 'https://example.com/privacy'}}
      restaurantId={restaurantId}
      province="QC"
      canManagePrivacy={true}
    />);

    const notices = Array.from(view.container.querySelectorAll<HTMLElement>('[lang]'));
    expect(notices.map((element) => element.lang)).toEqual(['fr-CA', 'en-CA']);
    expect(notices[0]?.textContent).toMatch(/^Cet appel peut être enregistré/u);
    expect(notices[1]?.textContent).toContain('This call may be recorded to help us serve you');
    expect((screen.getByRole('textbox', {name: 'Recording notice'}) as HTMLTextAreaElement).value)
      .toMatch(/^Cet appel peut être enregistré[\s\S]+This call may be recorded/u);
    expect(screen.getByRole('button', {name: 'Save recording notice'})).toBeTruthy();
    expect(screen.getByRole('checkbox', {name: 'Record calls'})).toBeTruthy();
    expect(screen.getByRole('checkbox', {name: 'Create call transcripts'})).toBeTruthy();
    expect(screen.getByText(/Turning off recording does not turn off transcripts/u)).toBeTruthy();
    expect(screen.getByText('Requires Canadian legal review before launch')).toBeTruthy();
  });

  it('renders bounded retention fields in English and French with the owner defaults', () => {
    const props = {
      notifications: {messageTaken: true, missedTransfer: true, flaggedCall: true, lowBalance: true, dailyDigest: false},
      spendCapCents: 20_000,
      legal: {recordingNotice: '', recordingEnabled: true, transcriptEnabled: true, legalReviewRequired: true, privacyPolicyUrl: 'https://example.com/privacy', recordingRetentionDays: 90, transcriptRetentionDays: 365},
      restaurantId,
      province: 'ON' as const,
      canManagePrivacy: true,
    };
    provider(<SettingsControls {...props}/>);
    const recording = screen.getByRole('spinbutton', {name: 'Keep recordings (days)'}) as HTMLInputElement;
    expect({value: recording.value, min: recording.min, max: recording.max}).toEqual({value: '90', min: '30', max: '365'});
    cleanup();
    render(<NextIntlClientProvider locale="fr" messages={messagesFr}><SettingsControls {...props}/></NextIntlClientProvider>);
    expect(screen.getByRole('spinbutton', {name: 'Conserver les enregistrements (jours)'})).toBeTruthy();
    expect(screen.getByRole('spinbutton', {name: 'Conserver les transcriptions (jours)'})).toBeTruthy();
  });
});

describe('caller privacy request intake', () => {
  it.each(['export', 'delete'] as const)('submits an auditable %s request and announces identity verification', async (requestType) => {
    const request = vi.fn(async () => Response.json({
      id: '33333333-3333-4333-8333-333333333333', status: 'received', requestType, verification: 'required', dueAt: '2026-11-26T12:00:00.000Z',
    }, {status: 202}));
    provider(<PrivacyRequestForm restaurantId={restaurantId} province="QC" request={request}/>);

    fireEvent.change(screen.getByRole('combobox', {name: 'Request type'}), {target: {value: requestType}});
    fireEvent.change(screen.getByRole('textbox', {name: 'Caller phone number'}), {target: {value: '+14165550123'}});
    fireEvent.submit(screen.getByRole('form', {name: 'Caller data request'}));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/privacy-requests', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({restaurantId, callerPhone: '+14165550123', requestType}),
    })));
    expect((await screen.findByRole('status')).textContent).toContain('Verify the caller’s identity');
    expect(screen.getByText(/30 days/u)).toBeTruthy();
    expect(screen.getByText(/Law 25/u)).toBeTruthy();
  });

  it('shows the durable request ID and advances verification before fulfillment', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({requests: []}))
      .mockResolvedValueOnce(Response.json({id: '33333333-3333-4333-8333-333333333333', status: 'received', requestType: 'export', verification: 'required', dueAt: '2026-11-26T12:00:00.000Z'}, {status: 202}))
      .mockResolvedValueOnce(Response.json({id: '33333333-3333-4333-8333-333333333333', status: 'verified', requestType: 'export', verification: 'verified', dueAt: '2026-11-26T12:00:00.000Z'}))
      .mockResolvedValueOnce(Response.json({id: '33333333-3333-4333-8333-333333333333', status: 'completed', requestType: 'export', verification: 'verified', dueAt: '2026-11-26T12:00:00.000Z', result: {bookings: []}}));
    provider(<PrivacyRequestForm restaurantId={restaurantId} province="ON" canManage request={request}/>);
    fireEvent.change(screen.getByRole('textbox', {name: 'Caller phone number'}), {target: {value: '+14165550123'}});
    fireEvent.submit(screen.getByRole('form', {name: 'Caller data request'}));

    expect(await screen.findByText(/33333333-3333-4333-8333-333333333333/u)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', {name: 'Verification reference'}), {target: {value: 'case-1234'}});
    fireEvent.click(screen.getByRole('button', {name: 'Mark identity verified'}));
    await screen.findByRole('button', {name: 'Fulfill verified request'});
    fireEvent.click(screen.getByRole('button', {name: 'Fulfill verified request'}));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('/api/privacy-requests', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({requestId: '33333333-3333-4333-8333-333333333333', action: 'fulfill', restaurantId, callerPhone: '+14165550123'}),
    })));
    expect(await screen.findByText('Completed')).toBeTruthy();
  });

  it('keeps entered data and shows a retryable error when intake fails', async () => {
    const request = vi.fn(async () => Response.json({
      error: {code: 'INTERNAL_ERROR', message: 'Request could not be recorded'},
    }, {status: 500}));
    provider(<PrivacyRequestForm restaurantId={restaurantId} province="ON" request={request}/>);

    const phone = screen.getByRole('textbox', {name: 'Caller phone number'}) as HTMLInputElement;
    fireEvent.change(phone, {target: {value: '+14165550123'}});
    fireEvent.submit(screen.getByRole('form', {name: 'Caller data request'}));

    expect((await screen.findByRole('alert')).textContent).toContain('The request could not be processed');
    expect(phone.value).toBe('+14165550123');
  });

  it('has no automated accessibility violations', async () => {
    const {default: axe} = await import('axe-core');
    const view = provider(<PrivacyRequestForm restaurantId={restaurantId} province="ON" request={vi.fn()}/>);
    const results = await axe.run(view.container, {rules: {'color-contrast': {enabled: false}}});
    expect(results.violations.map(({id}) => id)).toEqual([]);
  });
});
