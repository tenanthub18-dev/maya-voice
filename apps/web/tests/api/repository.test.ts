import {describe, expect, it} from 'vitest';

import {SupabaseApiRepository, type SupabaseLike} from '@/lib/api/repository';

function clientReturning(data: unknown, error: {code?: string; message: string} | null = null) {
  const calls: Array<{table: string; operation: string; value: unknown}> = [];
  const client: SupabaseLike = {
    async rpc(name, args) {
      calls.push({table: name, operation: 'rpc', value: args});
      return {data, error};
    },
    from(table) {
      const chain = {
        insert(value: unknown) { calls.push({table, operation: 'insert', value}); return chain; },
        update(value: unknown) { calls.push({table, operation: 'update', value}); return chain; },
        upsert(value: unknown) { calls.push({table, operation: 'upsert', value}); return chain; },
        select() { return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({data, error}),
      };
      return chain;
    },
    storage: {from(bucket) { return {async remove(paths) {
      calls.push({table: `storage:${bucket}`, operation: 'remove', value: paths});
      return {data: paths, error: null};
    }, async createSignedUrls(paths, expiresIn) {
      calls.push({table: `storage:${bucket}`, operation: 'sign', value: {paths, expiresIn}});
      return {data: paths.map((path) => ({path, signedUrl: `https://signed.example/${path}`})), error: null};
    }}; }},
  };
  return {client, calls};
}

describe('SupabaseApiRepository', () => {
  it('projects and returns live paid status for payment-link refusal', async () => {
    const selects: Array<[string, string | undefined]> = [];
    const client: SupabaseLike = {
      async rpc() { return {data: null, error: null}; },
      from(table) {
        const chain = {
          insert() { return chain; }, update() { return chain; }, upsert() { return chain; },
          select(columns?: string) { selects.push([table, columns]); return chain; },
          eq() { return chain; },
          maybeSingle: async () => ({
            data: table === 'restaurants'
              ? {id: 'restaurant-1', stripe_connected_account_id: 'acct_1', booking_deposit_cents: 2_000}
              : {id: 'order-1', restaurant_id: 'restaurant-1', total_cents: 4_275, paid_status: 'paid'},
            error: null,
          }),
        };
        return chain;
      },
      storage: {from() { return {
        async remove() { return {data: [], error: null}; },
        async createSignedUrls() { return {data: [], error: null}; },
      }; }},
    };

    await expect(new SupabaseApiRepository(client).getPaymentTarget({
      restaurantId: 'restaurant-1', kind: 'order', id: 'order-1',
    })).resolves.toMatchObject({paidStatus: 'paid', amountCents: 4_275});
    expect(selects).toContainEqual(['orders', 'id,restaurant_id,total_cents,paid_status']);
  });

  it('atomically claims a provider event and reports duplicates', async () => {
    const claimed = clientReturning(true);
    await expect(new SupabaseApiRepository(claimed.client).claimEvent('stripe', 'evt_1')).resolves.toBe(true);
    expect(claimed.calls[0]).toEqual({
      table: 'claim_processed_event', operation: 'rpc',
      value: {p_provider: 'stripe', p_event_id: 'evt_1'},
    });

    const duplicate = clientReturning(false);
    await expect(new SupabaseApiRepository(duplicate.client).claimEvent('stripe', 'evt_1')).resolves.toBe(false);
  });

  it('does not hide non-duplicate storage failures', async () => {
    const failed = clientReturning(null, {code: '42501', message: 'denied'});
    await expect(new SupabaseApiRepository(failed.client).claimEvent('stripe', 'evt_1')).rejects.toThrow('denied');
  });

  it('looks up webhook ownership by configured phone number', async () => {
    const found = clientReturning({restaurant_id: 'restaurant-1'});
    await expect(new SupabaseApiRepository(found.client).findRestaurantIdByPhoneNumber('+14165550123'))
      .resolves.toBe('restaurant-1');
  });

  it('looks up restaurant ownership before creating an import', async () => {
    const found = clientReturning({organization_id: 'organization-1'});
    await expect(new SupabaseApiRepository(found.client).findRestaurantOrganizationId('restaurant-1'))
      .resolves.toBe('organization-1');
  });

  it('applies billing state through the timestamp-guarded database function', async () => {
    const updated = clientReturning('applied');
    await expect(new SupabaseApiRepository(updated.client).updateOrganizationBilling(
      'cus_1', {stripe_subscription_status: 'active', stripe_subscription_event_created_at: '2026-10-27T12:00:00.000Z'},
    )).resolves.toBe('applied');
    expect(updated.calls[0]).toEqual({
      table: 'apply_stripe_billing_event', operation: 'rpc', value: {
        p_customer_id: 'cus_1', p_restaurant_id: null, p_category: 'subscription',
        p_event_created_at: '2026-10-27T12:00:00.000Z',
        p_value: {stripe_subscription_status: 'active', stripe_subscription_event_created_at: '2026-10-27T12:00:00.000Z'},
      },
    });
  });

  it('uses one atomic insert for import review rows and orders SMS receipts in SQL', async () => {
    const rows = clientReturning(true);
    const reviewRows = [{job_id: 'job-1', restaurant_id: 'restaurant-1', kind: 'menu'}];
    await new SupabaseApiRepository(rows.client).saveImportReviewRows('job-1', 'restaurant-1', reviewRows);
    expect(rows.calls[0]).toEqual({
      table: 'replace_import_review_rows', operation: 'rpc', value: {
        p_job_id: 'job-1', p_restaurant_id: 'restaurant-1', p_rows: reviewRows,
      },
    });

    const sms = clientReturning('applied');
    await new SupabaseApiRepository(sms.client).updateSmsDelivery(
      'msg-1', 'delivered', '2026-10-27T12:00:00.000Z', [],
    );
    expect(sms.calls[0]).toEqual({
      table: 'apply_sms_delivery_event', operation: 'rpc', value: {
        p_provider_message_id: 'msg-1', p_status: 'delivered',
        p_event_at: '2026-10-27T12:00:00.000Z', p_delivery_error: [],
      },
    });
  });

  it('replaces prior import rows even when the retry extracts no rows', async () => {
    const rows = clientReturning(true);
    await new SupabaseApiRepository(rows.client).saveImportReviewRows('job-1', 'restaurant-1', []);
    expect(rows.calls[0]).toEqual({
      table: 'replace_import_review_rows', operation: 'rpc', value: {
        p_job_id: 'job-1', p_restaurant_id: 'restaurant-1', p_rows: [],
      },
    });
  });

  it('claims import extraction through the database lease', async () => {
    const claimed = clientReturning(true);
    await expect(new SupabaseApiRepository(claimed.client).claimImportExtraction('job-1'))
      .resolves.toBe(true);
    expect(claimed.calls[0]).toEqual({
      table: 'claim_import_extraction', operation: 'rpc', value: {p_job_id: 'job-1'},
    });
  });

  it('loads ownership data and updates a locally managed phone number', async () => {
    const saved = clientReturning({id: 'phone-1'});
    await expect(new SupabaseApiRepository(saved.client).savePhoneNumber({
      restaurant_id: 'restaurant-1', telnyx_number_id: 'telnyx-1',
    })).resolves.toBe('phone-1');

    const phone = clientReturning({
      id: 'phone-1', restaurant_id: 'restaurant-1', e164: '+14165550123',
      telnyx_number_id: 'telnyx-1', status: 'active',
    });
    await expect(new SupabaseApiRepository(phone.client).getPhoneNumber('phone-1')).resolves.toEqual({
      id: 'phone-1', restaurantId: 'restaurant-1', e164: '+14165550123',
      telnyxNumberId: 'telnyx-1', status: 'active', forwardingVerifiedAt: null,
    });

    const update = clientReturning({id: 'phone-1'});
    await new SupabaseApiRepository(update.client).updatePhoneNumber('phone-1', {status: 'released'});
    expect(update.calls[0]).toEqual({
      table: 'phone_numbers', operation: 'update', value: {status: 'released'},
    });
  });

  it('finalizes a released number and audit atomically', async () => {
    const finalized = clientReturning(true);
    await new SupabaseApiRepository(finalized.client).finalizePhoneRelease({
      phoneId: 'phone-1', actorId: 'actor-1', target: 'telnyx-1', reason: 'Closed',
    });
    expect(finalized.calls[0]).toEqual({
      table: 'finalize_phone_release', operation: 'rpc', value: {
        p_phone_id: 'phone-1', p_actor_id: 'actor-1',
        p_target: 'telnyx-1', p_reason: 'Closed',
      },
    });
  });

  it('persists and advances privacy requests through atomic database functions', async () => {
    const received = clientReturning({
      id: 'request-1', status: 'received', request_type: 'export', verification_status: 'required', due_at: '2026-11-26T12:00:00.000Z', result: null,
    });
    await expect(new SupabaseApiRepository(received.client).createPrivacyRequest({
      actorId: 'actor-1', organizationId: 'organization-1', restaurantId: 'restaurant-1',
      requestType: 'export', callerHash: 'a'.repeat(64), callerLast4: '0123',
    })).resolves.toEqual({id: 'request-1', status: 'received', requestType: 'export', verification: 'required', dueAt: '2026-11-26T12:00:00.000Z'});
    expect(received.calls[0]).toEqual({
      table: 'create_privacy_request', operation: 'rpc', value: {
        p_actor_id: 'actor-1', p_organization_id: 'organization-1', p_restaurant_id: 'restaurant-1',
        p_request_type: 'export',
        p_caller_phone_hash: 'a'.repeat(64), p_caller_phone_last4: '0123',
      },
    });

    const completed = clientReturning({
      id: 'request-1', status: 'completed', request_type: 'export', verification_status: 'verified', due_at: '2026-11-26T12:00:00.000Z', result: {bookings: [], calls: [{id: 'call-1', recording_path: 'restaurant/call.wav'}]},
    });
    await expect(new SupabaseApiRepository(completed.client).transitionPrivacyRequest({
      actorId: 'actor-1', organizationId: 'organization-1', requestId: 'request-1', action: 'fulfill',
      restaurantId: 'restaurant-1', callerPhone: '+14165550123', callerHash: 'a'.repeat(64),
    })).resolves.toMatchObject({status: 'completed', result: {bookings: [], calls: [{id: 'call-1', recordingUrl: 'https://signed.example/restaurant/call.wav', recordingUrlExpiresInSeconds: 300}]}});
    expect(completed.calls[0]).toEqual({
      table: 'prepare_privacy_request_fulfillment', operation: 'rpc', value: {
        p_actor_id: 'actor-1', p_organization_id: 'organization-1', p_request_id: 'request-1',
      },
    });
    expect(completed.calls[1]).toEqual({
      table: 'transition_privacy_request', operation: 'rpc', value: {
        p_actor_id: 'actor-1', p_organization_id: 'organization-1', p_request_id: 'request-1',
        p_action: 'fulfill', p_reason: null, p_verification_method: null, p_verification_reference: null,
        p_caller_phone_e164: '+14165550123', p_caller_phone_hash: 'a'.repeat(64),
        p_removed_recording_paths: [],
      },
    });
    expect(completed.calls[2]).toEqual({table: 'storage:recordings', operation: 'sign', value: {paths: ['restaurant/call.wav'], expiresIn: 300}});
  });

  it('does not complete deletion when recording object removal fails', async () => {
    const calls: string[] = [];
    const client: SupabaseLike = {
      from() { throw new Error('not used'); },
      async rpc(name) {
        calls.push(name);
        return name === 'prepare_privacy_request_fulfillment'
          ? {data: {request_type: 'delete', recording_paths: ['restaurant/call.wav']}, error: null}
          : {data: {id: 'request-1', status: 'completed'}, error: null};
      },
      storage: {from() { return {
        async remove() { return {data: null, error: {message: 'storage unavailable'}}; },
        async createSignedUrls() { return {data: [], error: null}; },
      }; }},
    };

    await expect(new SupabaseApiRepository(client).transitionPrivacyRequest({
      actorId: 'actor-1', organizationId: 'organization-1', requestId: 'request-1', action: 'fulfill',
    })).rejects.toThrow('storage unavailable');
    expect(calls).toEqual(['prepare_privacy_request_fulfillment']);
  });

  it('re-signs completed export recordings when the owner reloads the queue', async () => {
    const loaded = clientReturning([{
      id: 'request-1', status: 'completed', request_type: 'export', verification_status: 'verified',
      due_at: '2026-11-26T12:00:00.000Z', result: {calls: [{id: 'call-1', recording_path: 'restaurant/call.wav'}]},
    }]);
    const records = await new SupabaseApiRepository(loaded.client).listPrivacyRequests('actor-1', 'organization-1');
    expect(records[0]).toMatchObject({result: {calls: [{id: 'call-1', recordingUrl: 'https://signed.example/restaurant/call.wav', recordingUrlExpiresInSeconds: 300}]}});
    expect(JSON.stringify(records)).not.toContain('recording_path');
  });

  it('returns no raw path on immediate signing failure and permits safe reload signing', async () => {
    const row = {
      id: 'request-1', status: 'completed', request_type: 'export', verification_status: 'verified',
      due_at: '2026-11-26T12:00:00.000Z', result: {calls: [{id: 'call-1', recording_path: 'restaurant/call.wav'}]},
    };
    const failed = clientReturning(row);
    failed.client.storage.from = () => ({
      async remove() { return {data: [], error: null}; },
      async createSignedUrls() { return {data: null, error: {message: 'signing unavailable'}}; },
    });
    await expect(new SupabaseApiRepository(failed.client).transitionPrivacyRequest({
      actorId: 'actor-1', organizationId: 'organization-1', requestId: 'request-1', action: 'fulfill',
    })).rejects.toThrow('signing unavailable');

    const resumed = clientReturning([row]);
    const records = await new SupabaseApiRepository(resumed.client).listPrivacyRequests('actor-1', 'organization-1');
    expect(JSON.stringify(records)).not.toContain('recording_path');
    expect(records[0]).toMatchObject({result: {calls: [{recordingUrl: 'https://signed.example/restaurant/call.wav'}]}});
  });

  it('purges expired export payloads through the database lifecycle function', async () => {
    const purged = clientReturning(2);
    await expect(new SupabaseApiRepository(purged.client).purgeExpiredPrivacyResults()).resolves.toBe(2);
    expect(purged.calls[0]).toEqual({table: 'purge_expired_privacy_results', operation: 'rpc', value: {}});
  });
});
