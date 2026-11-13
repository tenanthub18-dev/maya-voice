import {describe, expect, it, vi} from 'vitest';

import {createRecordingHandler} from '@/app/api/calls/[id]/recording/_lib';

const user = {id: 'user-1', email: 'owner@example.com', role: 'owner' as const, organizationId: 'org-1'};

describe('authorized recording route', () => {
  it('redirects to a five-minute signed URL only after tenant authorization', async () => {
    const signedRecordingUrl = vi.fn(async () => 'https://storage.example/signed?token=opaque');
    const handler = createRecordingHandler({
      authorize: async () => ({ok: true, user}),
      signedRecordingUrl,
    });

    const response = await handler(new Request('https://app.example/api/calls/call-1/recording'), {
      params: Promise.resolve({id: 'call-1'}),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://storage.example/signed?token=opaque');
    expect(signedRecordingUrl).toHaveBeenCalledWith('call-1', 'org-1', 300);
  });

  it('returns 404 without signing for a cross-tenant or missing recording', async () => {
    const signedRecordingUrl = vi.fn(async () => null);
    const handler = createRecordingHandler({
      authorize: async () => ({ok: true, user}),
      signedRecordingUrl,
    });

    const response = await handler(new Request('https://app.example/api/calls/foreign/recording'), {
      params: Promise.resolve({id: 'foreign'}),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({error: {code: 'NOT_FOUND', message: 'Recording not found'}});
  });

  it('returns the uniform auth response before looking up storage', async () => {
    const signedRecordingUrl = vi.fn();
    const handler = createRecordingHandler({
      authorize: async () => ({ok: false, response: Response.json({error: {code: 'UNAUTHORIZED', message: 'Authentication required'}}, {status: 401})}),
      signedRecordingUrl,
    });
    const response = await handler(new Request('https://app.example/api/calls/call-1/recording'), {
      params: Promise.resolve({id: 'call-1'}),
    });
    expect(response.status).toBe(401);
    expect(signedRecordingUrl).not.toHaveBeenCalled();
  });

  it('requires an active support session before an admin URL is signed', async () => {
    const admin = {id: 'admin-1', email: 'admin@example.com', role: 'platform-admin' as const, organizationId: null};
    const signedAdminRecordingUrl = vi.fn(async () => ({kind: 'forbidden' as const}));
    const signedRecordingUrl = vi.fn();
    const handler = createRecordingHandler({
      authorize: async () => ({ok: true, user: admin}),
      signedRecordingUrl,
      signedAdminRecordingUrl,
    });

    const response = await handler(new Request('https://app.example/api/calls/call-1/recording'), {
      params: Promise.resolve({id: 'call-1'}),
    });

    expect(response.status).toBe(403);
    expect(signedAdminRecordingUrl).toHaveBeenCalledWith('call-1', 300);
    expect(signedRecordingUrl).not.toHaveBeenCalled();
  });

  it('redirects an admin only after the audited support lookup returns a signed URL', async () => {
    const admin = {id: 'admin-1', email: 'admin@example.com', role: 'platform-admin' as const, organizationId: null};
    const signedAdminRecordingUrl = vi.fn(async () => ({kind: 'signed' as const, url: 'https://storage.example/admin-signed'}));
    const handler = createRecordingHandler({
      authorize: async () => ({ok: true, user: admin}),
      signedRecordingUrl: vi.fn(),
      signedAdminRecordingUrl,
    });

    const response = await handler(new Request('https://app.example/api/calls/call-1/recording'), {
      params: Promise.resolve({id: 'call-1'}),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://storage.example/admin-signed');
  });
});
