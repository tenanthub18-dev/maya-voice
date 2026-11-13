// @vitest-environment jsdom

import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {WebsiteImportFlow} from '@/components/onboarding-import-flow';
import {NumberLifecycleFlow} from '@/components/onboarding-number-flow';
import messages from '@/messages/en.json';

const restaurantId = '11111111-1111-4111-8111-111111111111';
const phoneNumberId = '33333333-3333-4333-8333-333333333333';
const basics = {name: 'Restaurant', address: '1 Main St', websiteUrl: 'https://restaurant.example', cuisine: 'Canadian'};

function provider(children: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('website import flow', () => {
  it('polls the API lifecycle, shows progress, and continues with the imported URL', async () => {
    const saveStep = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({id: 'job-1', status: 'processing'}, {status: 202}))
      .mockResolvedValueOnce(Response.json({id: 'job-1', status: 'processing'}))
      .mockResolvedValueOnce(Response.json({id: 'job-1', status: 'completed', reviewRowCount: 3}));

    provider(<WebsiteImportFlow restaurantId={restaurantId} basics={basics} saveStep={saveStep} request={request}/>);
    fireEvent.submit(screen.getByRole('form', {name: 'Website import'}));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/import', expect.objectContaining({method: 'POST'})));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');

    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100'), {timeout: 2500});

    fireEvent.click(screen.getByRole('button', {name: 'Continue'}));
    await waitFor(() => expect(saveStep).toHaveBeenCalledWith(expect.objectContaining({
      basics: expect.objectContaining({websiteUrl: 'https://restaurant.example'}),
      completedStep: 2,
      importJobId: 'job-1',
    })));
  });

  it('offers retry and manual entry when an API error is returned', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({error: {code: 'PROVIDER_ERROR', message: 'Website import provider request failed'}}, {status: 502}))
      .mockResolvedValueOnce(Response.json({id: 'job-2', status: 'processing'}, {status: 202}));
    const saveStep = vi.fn().mockResolvedValue(undefined);

    provider(<WebsiteImportFlow restaurantId={restaurantId} basics={basics} saveStep={saveStep} request={request}/>);
    fireEvent.submit(screen.getByRole('form', {name: 'Website import'}));
    expect((await screen.findByRole('alert')).textContent).toContain('The import service is temporarily unavailable');

    fireEvent.click(screen.getByRole('button', {name: 'Retry import'}));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', {name: 'Enter details manually'}));
    await waitFor(() => expect(saveStep).toHaveBeenCalledWith(expect.objectContaining({
      basics: expect.objectContaining({websiteUrl: 'https://restaurant.example'}),
      completedStep: 2,
    })));
  });

  it('warns when a completed import is missing review sections', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({id: 'job-partial', status: 'processing'}, {status: 202}))
      .mockResolvedValueOnce(Response.json({
        id: 'job-partial', status: 'completed', reviewRowCount: 1,
        reviewCounts: {menu: 0, hours: 1, faqs: 0}, partial: true,
      }));

    provider(<WebsiteImportFlow restaurantId={restaurantId} basics={basics} saveStep={vi.fn()} request={request}/>);
    fireEvent.submit(screen.getByRole('form', {name: 'Website import'}));

    expect((await screen.findByRole('alert')).textContent).toContain('Menu, frequently asked questions');
    expect(screen.getByRole('button', {name: 'Enter details manually'})).toBeTruthy();
    expect(screen.getByRole('form', {name: 'Upload a menu'})).toBeTruthy();
  });

  it('uploads a PDF or photo fallback and surfaces incomplete-menu metadata', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({error: {code: 'SCHEMA_MISMATCH', message: 'untrusted'}}, {status: 502}))
      .mockResolvedValueOnce(Response.json({
        id: 'upload-1', status: 'completed', reviewRowCount: 1,
        reviewCounts: {menu: 1, hours: 0, faqs: 0}, partial: true, incompleteMenu: true,
      }));
    provider(<WebsiteImportFlow restaurantId={restaurantId} basics={basics} saveStep={vi.fn()} request={request}/>);

    fireEvent.submit(screen.getByRole('form', {name: 'Website import'}));
    await screen.findByRole('form', {name: 'Upload a menu'});

    fireEvent.change(screen.getByLabelText('Menu PDF or photo'), {
      target: {files: [new File(['menu'], 'menu.pdf', {type: 'application/pdf'})]},
    });
    fireEvent.submit(screen.getByRole('form', {name: 'Upload a menu'}));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/import/file', expect.objectContaining({method: 'POST'})));
    expect((await screen.findByRole('alert')).textContent).toContain('some menu items or prices');
  });
});

describe('Canadian number lifecycle', () => {
  it('searches, buys, assigns, verifies forwarding, and releases with an audit reason', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({data: [{phone_number: '+14165550123', record_type: 'available_phone_number', features: [], cost_information: {upfront_cost: '0.00', monthly_cost: '0.35', currency: 'USD'}}]}))
      .mockResolvedValueOnce(Response.json({phoneNumberId, data: {id: 'order-1', record_type: 'number_order', status: 'success', phone_numbers: [{id: 'telnyx-1', phone_number: '+14165550123', status: 'active'}]}}, {status: 201}))
      .mockResolvedValueOnce(Response.json({data: {id: 'telnyx-1', record_type: 'phone_number', phone_number: '+14165550123', status: 'active'}}))
      .mockResolvedValueOnce(Response.json({verified: true, verifiedAt: '2026-10-27T12:00:00.000Z'}))
      .mockResolvedValueOnce(Response.json({data: {id: 'telnyx-1', record_type: 'phone_number', phone_number: '+14165550123', status: 'deleted'}}));

    provider(<NumberLifecycleFlow restaurantId={restaurantId} initialPhone={null} request={request}/>);
    fireEvent.change(screen.getByLabelText('Canadian area code'), {target: {value: '416'}});
    fireEvent.click(screen.getByRole('button', {name: 'Search numbers'}));
    expect((await screen.findByText('+14165550123')).textContent).toBe('+14165550123');

    fireEvent.click(screen.getByRole('button', {name: 'Buy +14165550123'}));
    await waitFor(() => expect(request).toHaveBeenNthCalledWith(3, '/api/telnyx/numbers/assign', expect.objectContaining({method: 'POST'})));
    expect((await screen.findByText('Bell Mobility')).textContent).toBe('Bell Mobility');

    fireEvent.click(screen.getByRole('button', {name: 'Run forwarding check'}));
    expect((await screen.findByText('Forwarding verified')).textContent).toBe('Forwarding verified');

    fireEvent.click(screen.getByRole('button', {name: 'Release number'}));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason for release'), {target: {value: 'Restaurant closed'}});
    fireEvent.click(screen.getByRole('button', {name: 'Confirm release'}));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('/api/telnyx/numbers/release', expect.objectContaining({
      body: JSON.stringify({phoneNumberId, reason: 'Restaurant closed'}),
    })));
    expect((await screen.findByRole('status')).textContent).toContain('Number released. Audit reason: Restaurant closed');
  });

  it('shows a retry action when a route returns an API error', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({error: {code: 'PROVIDER_ERROR', message: 'Telnyx request failed'}}, {status: 502}));
    provider(<NumberLifecycleFlow restaurantId={restaurantId} initialPhone={null} request={request}/>);

    fireEvent.click(screen.getByRole('button', {name: 'Search numbers'}));
    expect((await screen.findByRole('alert')).textContent).toContain('The phone number request failed');
    expect(screen.getByRole('button', {name: 'Retry search'})).toBeTruthy();
  });
});
