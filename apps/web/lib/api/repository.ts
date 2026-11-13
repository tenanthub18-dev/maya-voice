export interface QueryResult<T = unknown> {data: T | null; error: {code?: string; message: string} | null}

export interface SupabaseFilterQuery {
  select(columns?: string): SupabaseFilterQuery;
  eq(column: string, value: unknown): SupabaseFilterQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

export interface SupabaseTable {
  delete?(): SupabaseFilterQuery;
  insert(value: unknown): SupabaseFilterQuery;
  update(value: unknown): SupabaseFilterQuery;
  upsert(value: unknown, options?: unknown): SupabaseFilterQuery;
  select(columns?: string): SupabaseFilterQuery;
}

export interface SupabaseLike {
  from(table: string): SupabaseTable;
  rpc(name: string, args: Record<string, unknown>): PromiseLike<QueryResult>;
  storage: {from(bucket: string): {
    remove(paths: string[]): PromiseLike<QueryResult>;
    createSignedUrls(paths: string[], expiresIn: number): PromiseLike<QueryResult>;
  }};
}

export type EventProvider = 'stripe' | 'telnyx-sms' | 'resend';
export type OrderedMutationResult = 'applied' | 'stale' | 'not_found';
export type PrivacyRequestAction = 'verify' | 'fulfill' | 'reject';
export interface PrivacyRequestRecord {
  id: string;
  status: 'received' | 'verified' | 'fulfilling' | 'completed' | 'rejected';
  requestType: 'export' | 'delete';
  verification: 'required' | 'verified' | 'rejected';
  dueAt: string;
  result?: unknown;
}

export interface ManagedPhoneNumber {
  id: string;
  restaurantId: string;
  e164: string;
  telnyxNumberId: string;
  status: string;
  forwardingVerifiedAt?: string | null;
}

export interface PaymentTarget {
  kind: 'order' | 'booking';
  id: string;
  restaurantId: string;
  amountCents: number;
  paidStatus: 'unpaid' | 'paid' | 'refunded';
  connectedAccountId: string | null;
}

export interface ApiRepository {
  prepareRetention(now: string): Promise<{recordingPaths: string[]; recordings: number; transcripts: number}>;
  removeRecordings(paths: string[]): Promise<void>;
  completeRetention(input: {now: string; dryRun: boolean; removedRecordingPaths: string[]}): Promise<{recordings: number; transcripts: number}>;
  claimEvent(provider: EventProvider, eventId: string): Promise<boolean>;
  completeEvent(provider: EventProvider, eventId: string): Promise<void>;
  failEvent(provider: EventProvider, eventId: string, errorMessage: string): Promise<void>;
  createImportJob(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getImportJob(id: string): Promise<Record<string, unknown> | null>;
  updateImportJob(id: string, value: Record<string, unknown>): Promise<void>;
  claimImportExtraction(id: string): Promise<boolean>;
  saveImportReviewRows(jobId: string, restaurantId: string, rows: readonly Record<string, unknown>[]): Promise<void>;
  findRestaurantOrganizationId(restaurantId: string): Promise<string | null>;
  addSmsOptOut(restaurantId: string, phoneE164: string): Promise<void>;
  removeSmsOptOut(restaurantId: string, phoneE164: string): Promise<void>;
  findRestaurantIdByPhoneNumber(e164: string): Promise<string | null>;
  updateSmsDelivery(providerMessageId: string, status: 'sent' | 'delivered' | 'failed', eventAt?: string, deliveryError?: unknown): Promise<OrderedMutationResult>;
  updateOrganizationBilling(stripeCustomerId: string | null, value: Record<string, unknown>, restaurantId?: string): Promise<OrderedMutationResult>;
  markPaymentPaid(accountId: string, kind: 'order' | 'booking', targetId: string): Promise<OrderedMutationResult>;
  getPhoneNumber(id: string): Promise<ManagedPhoneNumber | null>;
  savePhoneNumber(value: Record<string, unknown>): Promise<string>;
  updatePhoneNumber(id: string, value: Record<string, unknown>): Promise<void>;
  finalizePhoneRelease(input: {phoneId: string; actorId: string; target: string; reason: string}): Promise<void>;
  writeAudit(input: {actorId: string; action: string; target: string; reason: string}): Promise<void>;
  createPrivacyRequest(input: {
    actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
    callerHash: string; callerLast4: string;
  }): Promise<PrivacyRequestRecord>;
  transitionPrivacyRequest(input: {
    actorId: string; organizationId: string; requestId: string; action: PrivacyRequestAction; reason?: string;
    verificationMethod?: 'callback' | 'account-record' | 'written-document'; verificationReference?: string;
    restaurantId?: string; callerPhone?: string; callerHash?: string;
  }): Promise<PrivacyRequestRecord>;
  listPrivacyRequests(actorId: string, organizationId: string): Promise<PrivacyRequestRecord[]>;
  purgeExpiredPrivacyResults(): Promise<number>;
  executeRestaurantPrivacyRequest(input: {
    actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
  }): Promise<PrivacyRequestRecord>;
  getOrganizationBilling(id: string): Promise<{id: string; name: string; stripeCustomerId: string | null} | null>;
  getRestaurantIdForOrganization(id: string): Promise<string | null>;
  setOrganizationStripeCustomerId(id: string, customerId: string): Promise<void>;
  getRestaurantPaymentConnection(organizationId: string): Promise<{restaurantId: string; connectedAccountId: string | null} | null>;
  setRestaurantConnectedAccount(restaurantId: string, accountId: string | null): Promise<void>;
  getPaymentTarget(input: {restaurantId: string; kind: 'order' | 'booking'; id: string}): Promise<PaymentTarget | null>;
  isDinerPaymentsEnabled(restaurantId: string): Promise<boolean>;
  signedRecordingUrl(callId: string, organizationId: string, expiresInSeconds: number): Promise<string | null>;
  signedRecordingPath(path: string, expiresInSeconds: number): Promise<string | null>;
}

function storageError(error: {message: string}): Error {
  return new Error(error.message);
}

export class SupabaseApiRepository implements ApiRepository {
  constructor(private readonly client: SupabaseLike) {}

  async prepareRetention(now: string): Promise<{recordingPaths: string[]; recordings: number; transcripts: number}> {
    const result = await this.client.rpc('prepare_retention', {p_now: now});
    if (result.error) throw storageError(result.error);
    const value = result.data as {recording_paths?: unknown; recordings?: unknown; transcripts?: unknown} | null;
    if (!value || !Array.isArray(value.recording_paths) || value.recording_paths.some((path) => typeof path !== 'string')
      || typeof value.recordings !== 'number' || typeof value.transcripts !== 'number') throw new Error('Retention plan is malformed');
    return {recordingPaths: value.recording_paths as string[], recordings: value.recordings, transcripts: value.transcripts};
  }

  async removeRecordings(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // Storage deletion removes both object bytes and metadata: https://supabase.com/docs/reference/javascript/storage-from-remove
    const result = await this.client.storage.from('recordings').remove(paths);
    if (result.error) throw storageError(result.error);
  }

  async completeRetention(input: {now: string; dryRun: boolean; removedRecordingPaths: string[]}): Promise<{recordings: number; transcripts: number}> {
    const result = await this.client.rpc('execute_retention', {
      p_now: input.now, p_dry_run: input.dryRun, p_removed_recording_paths: input.removedRecordingPaths,
    });
    if (result.error) throw storageError(result.error);
    const value = result.data as {recordings?: unknown; transcripts?: unknown} | null;
    if (!value || typeof value.recordings !== 'number' || typeof value.transcripts !== 'number') throw new Error('Retention result is malformed');
    return {recordings: value.recordings, transcripts: value.transcripts};
  }

  async signedRecordingUrl(callId: string, organizationId: string, expiresInSeconds: number): Promise<string | null> {
    const lookup = await this.client.rpc('get_authorized_recording_path', {
      p_call_id: callId,
      p_organization_id: organizationId,
    });
    if (lookup.error) throw storageError(lookup.error);
    if (lookup.data === null) return null;
    if (typeof lookup.data !== 'string') throw new Error('Recording path lookup returned invalid data');
    return this.signedRecordingPath(lookup.data, expiresInSeconds);
  }

  async signedRecordingPath(path: string, expiresInSeconds: number): Promise<string | null> {
    const signed = await this.client.storage.from('recordings').createSignedUrls([path], expiresInSeconds);
    if (signed.error) throw storageError(signed.error);
    const row = Array.isArray(signed.data) ? signed.data[0] as {signedUrl?: unknown} | undefined : undefined;
    return typeof row?.signedUrl === 'string' ? row.signedUrl : null;
  }

  async claimEvent(provider: EventProvider, eventId: string): Promise<boolean> {
    const {data, error} = await this.client.rpc('claim_processed_event', {
      p_provider: provider,
      p_event_id: eventId,
    });
    if (error) throw storageError(error);
    return data === true;
  }

  async completeEvent(provider: EventProvider, eventId: string): Promise<void> {
    await this.updateEvent(provider, eventId, {status: 'completed', processed_at: new Date().toISOString(), error: null});
  }

  async failEvent(provider: EventProvider, eventId: string, errorMessage: string): Promise<void> {
    await this.updateEvent(provider, eventId, {status: 'failed', error: errorMessage});
  }

  private async updateEvent(provider: EventProvider, eventId: string, value: unknown): Promise<void> {
    const result = await this.client.from('processed_events').update(value)
      .eq('provider', provider).eq('event_id', eventId).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async createImportJob(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.client.from('import_jobs').insert(input).select('*').maybeSingle();
    if (result.error) throw storageError(result.error);
    if (!result.data || typeof result.data !== 'object') throw new Error('Import job insert returned no row');
    return result.data as Record<string, unknown>;
  }

  async getImportJob(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.client.from('import_jobs').select('*').eq('id', id).maybeSingle();
    if (result.error) throw storageError(result.error);
    return result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : null;
  }

  async updateImportJob(id: string, value: Record<string, unknown>): Promise<void> {
    const result = await this.client.from('import_jobs').update(value).eq('id', id).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async claimImportExtraction(id: string): Promise<boolean> {
    const result = await this.client.rpc('claim_import_extraction', {p_job_id: id});
    if (result.error) throw storageError(result.error);
    return result.data === true;
  }

  async saveImportReviewRows(
    jobId: string,
    restaurantId: string,
    rows: readonly Record<string, unknown>[],
  ): Promise<void> {
    if (rows.some(
      (row) => row.job_id !== jobId || row.restaurant_id !== restaurantId,
    )) throw new Error('Import review rows must belong to one job and restaurant');
    const result = await this.client.rpc('replace_import_review_rows', {
      p_job_id: jobId,
      p_restaurant_id: restaurantId,
      p_rows: rows,
    });
    if (result.error) throw storageError(result.error);
  }

  async findRestaurantOrganizationId(restaurantId: string): Promise<string | null> {
    const result = await this.client.from('restaurants').select('organization_id')
      .eq('id', restaurantId).maybeSingle();
    if (result.error) throw storageError(result.error);
    const organizationId = (result.data as {organization_id?: unknown} | null)?.organization_id;
    return typeof organizationId === 'string' ? organizationId : null;
  }

  async addSmsOptOut(restaurantId: string, phoneE164: string): Promise<void> {
    const result = await this.client.from('sms_optouts').upsert(
      {restaurant_id: restaurantId, phone_e164: phoneE164},
      {onConflict: 'restaurant_id,phone_e164', ignoreDuplicates: true},
    ).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async removeSmsOptOut(restaurantId: string, phoneE164: string): Promise<void> {
    const table = this.client.from('sms_optouts');
    if (!table.delete) throw new Error('Supabase delete is unavailable');
    const result = await table.delete().eq('restaurant_id', restaurantId)
      .eq('phone_e164', phoneE164).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async findRestaurantIdByPhoneNumber(e164: string): Promise<string | null> {
    const result = await this.client.from('phone_numbers').select('restaurant_id')
      .eq('e164', e164).maybeSingle();
    if (result.error) throw storageError(result.error);
    const restaurantId = (result.data as {restaurant_id?: unknown} | null)?.restaurant_id;
    return typeof restaurantId === 'string' ? restaurantId : null;
  }

  async updateSmsDelivery(providerMessageId: string, status: 'sent' | 'delivered' | 'failed', eventAt?: string, deliveryError?: unknown): Promise<OrderedMutationResult> {
    const result = await this.client.rpc('apply_sms_delivery_event', {
      p_provider_message_id: providerMessageId,
      p_status: status,
      p_event_at: eventAt ?? null,
      p_delivery_error: deliveryError ?? null,
    });
    if (result.error) throw storageError(result.error);
    if (result.data !== 'applied' && result.data !== 'stale' && result.data !== 'not_found') {
      throw new Error('SMS delivery mutation returned an invalid result');
    }
    return result.data;
  }

  async updateOrganizationBilling(
    stripeCustomerId: string | null,
    value: Record<string, unknown>,
    restaurantId?: string,
  ): Promise<OrderedMutationResult> {
    const category = 'stripe_checkout_event_created_at' in value ? 'checkout'
      : 'stripe_subscription_event_created_at' in value ? 'subscription'
      : 'stripe_invoice_event_created_at' in value ? 'invoice'
      : 'stripe_billing_alert_event_created_at' in value ? 'billing_alert'
      : undefined;
    const eventCreatedAt = category === undefined
      ? undefined
      : value[`stripe_${category}_event_created_at`];
    if (category === undefined || typeof eventCreatedAt !== 'string') {
      throw new Error('Stripe billing mutation has no ordering category');
    }
    const result = await this.client.rpc('apply_stripe_billing_event', {
      p_customer_id: stripeCustomerId,
      p_restaurant_id: restaurantId ?? null,
      p_category: category,
      p_event_created_at: eventCreatedAt,
      p_value: value,
    });
    if (result.error) throw storageError(result.error);
    if (result.data !== 'applied' && result.data !== 'stale' && result.data !== 'not_found') {
      throw new Error('Stripe billing mutation returned an invalid result');
    }
    return result.data;
  }

  async markPaymentPaid(accountId: string, kind: 'order' | 'booking', targetId: string): Promise<OrderedMutationResult> {
    const result = await this.client.rpc('apply_connected_payment_event', {
      p_connected_account_id: accountId,
      p_target_kind: kind,
      p_target_id: targetId,
    });
    if (result.error) throw storageError(result.error);
    if (result.data !== 'applied' && result.data !== 'stale' && result.data !== 'not_found') {
      throw new Error('Connected payment mutation returned an invalid result');
    }
    return result.data;
  }

  async savePhoneNumber(value: Record<string, unknown>): Promise<string> {
    const result = await this.client.from('phone_numbers').upsert(value, {onConflict: 'telnyx_number_id'})
      .select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
    const id = (result.data as {id?: unknown} | null)?.id;
    if (typeof id !== 'string') throw new Error('Phone number upsert returned no id');
    return id;
  }

  async getPhoneNumber(id: string): Promise<ManagedPhoneNumber | null> {
    const result = await this.client.from('phone_numbers')
      .select('id,restaurant_id,e164,telnyx_number_id,status,forwarding_verified_at').eq('id', id).maybeSingle();
    if (result.error) throw storageError(result.error);
    const row = result.data as {
      id?: unknown; restaurant_id?: unknown; e164?: unknown;
      telnyx_number_id?: unknown; status?: unknown; forwarding_verified_at?: unknown;
    } | null;
    if (!row) return null;
    if (
      typeof row.id !== 'string' || typeof row.restaurant_id !== 'string' ||
      typeof row.e164 !== 'string' || typeof row.telnyx_number_id !== 'string' ||
      typeof row.status !== 'string'
    ) throw new Error('Phone number row is malformed');
    return {
      id: row.id,
      restaurantId: row.restaurant_id,
      e164: row.e164,
      telnyxNumberId: row.telnyx_number_id,
      status: row.status,
      forwardingVerifiedAt: typeof row.forwarding_verified_at === 'string'
        ? row.forwarding_verified_at
        : null,
    };
  }

  async updatePhoneNumber(id: string, value: Record<string, unknown>): Promise<void> {
    const result = await this.client.from('phone_numbers').update(value)
      .eq('id', id).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async finalizePhoneRelease(input: {
    phoneId: string; actorId: string; target: string; reason: string;
  }): Promise<void> {
    const result = await this.client.rpc('finalize_phone_release', {
      p_phone_id: input.phoneId,
      p_actor_id: input.actorId,
      p_target: input.target,
      p_reason: input.reason,
    });
    if (result.error) throw storageError(result.error);
  }

  async writeAudit(input: {actorId: string; action: string; target: string; reason: string}): Promise<void> {
    const result = await this.client.from('audit_log').insert({
      actor_id: input.actorId, action: input.action, target: input.target, reason: input.reason,
    }).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async createPrivacyRequest(input: {
    actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
    callerHash: string; callerLast4: string;
  }): Promise<PrivacyRequestRecord> {
    const result = await this.client.rpc('create_privacy_request', {
      p_actor_id: input.actorId,
      p_organization_id: input.organizationId,
      p_restaurant_id: input.restaurantId,
      p_request_type: input.requestType,
      p_caller_phone_hash: input.callerHash,
      p_caller_phone_last4: input.callerLast4,
    });
    if (result.error) throw storageError(result.error);
    return privacyRequestRecord(result.data);
  }

  async transitionPrivacyRequest(input: {
    actorId: string; organizationId: string; requestId: string; action: PrivacyRequestAction; reason?: string;
    verificationMethod?: 'callback' | 'account-record' | 'written-document'; verificationReference?: string;
    restaurantId?: string; callerPhone?: string; callerHash?: string;
  }): Promise<PrivacyRequestRecord> {
    let removedRecordingPaths: string[] = [];
    if (input.action === 'fulfill') {
      const prepared = await this.client.rpc('prepare_privacy_request_fulfillment', {
        p_actor_id: input.actorId,
        p_organization_id: input.organizationId,
        p_request_id: input.requestId,
      });
      if (prepared.error) throw storageError(prepared.error);
      const value = prepared.data as {request_type?: unknown; recording_paths?: unknown} | null;
      if (value?.request_type === 'delete') {
        if (!Array.isArray(value.recording_paths) || value.recording_paths.some((path) => typeof path !== 'string')) {
          throw new Error('Privacy request recording paths are malformed');
        }
        if (value.recording_paths.length > 0) {
          // Storage object deletion must use the Storage API so bytes and metadata are removed together.
          // https://supabase.com/docs/reference/javascript/storage-from-remove
          const removed = await this.client.storage.from('recordings').remove(value.recording_paths as string[]);
          if (removed.error) throw storageError(removed.error);
        }
        removedRecordingPaths = value.recording_paths as string[];
      }
    }
    const result = await this.client.rpc('transition_privacy_request', {
      p_actor_id: input.actorId,
      p_organization_id: input.organizationId,
      p_request_id: input.requestId,
      p_action: input.action,
      p_reason: input.reason ?? null,
      p_verification_method: input.verificationMethod ?? null,
      p_verification_reference: input.verificationReference ?? null,
      p_caller_phone_e164: input.callerPhone ?? null,
      p_caller_phone_hash: input.callerHash ?? null,
      p_removed_recording_paths: removedRecordingPaths,
    });
    if (result.error) throw storageError(result.error);
    return this.withSignedRecordings(privacyRequestRecord(result.data));
  }

  private async withSignedRecordings(record: PrivacyRequestRecord): Promise<PrivacyRequestRecord> {
    if (record.requestType === 'export' && record.result && typeof record.result === 'object') {
      const exportResult = record.result as {calls?: Array<Record<string, unknown>>};
      const paths = (exportResult.calls ?? []).map((call) => call.recording_path).filter((path): path is string => typeof path === 'string');
      if (paths.length > 0) {
        // Signed recording URLs expire after five minutes and never expose private object paths in the delivered export.
        // https://supabase.com/docs/reference/javascript/storage-from-createsignedurls
        const signed = await this.client.storage.from('recordings').createSignedUrls(paths, 300);
        if (signed.error || !Array.isArray(signed.data)) throw storageError(signed.error ?? {message: 'Recording URL signing failed'});
        const urls = new Map((signed.data as Array<{path?: unknown; signedUrl?: unknown}>).flatMap((item) =>
          typeof item.path === 'string' && typeof item.signedUrl === 'string' ? [[item.path, item.signedUrl] as const] : []));
        exportResult.calls = (exportResult.calls ?? []).map((call) => {
          const path = call.recording_path;
          const safeCall = {...call};
          delete safeCall.recording_path;
          return typeof path === 'string' ? {...safeCall, recordingUrl: urls.get(path) ?? null, recordingUrlExpiresInSeconds: 300} : safeCall;
        });
      }
    }
    return record;
  }

  async listPrivacyRequests(actorId: string, organizationId: string): Promise<PrivacyRequestRecord[]> {
    const result = await this.client.rpc('list_privacy_requests', {p_actor_id: actorId, p_organization_id: organizationId});
    if (result.error) throw storageError(result.error);
    if (!Array.isArray(result.data)) throw new Error('Privacy request list is malformed');
    return Promise.all(result.data.map((value) => this.withSignedRecordings(privacyRequestRecord(value))));
  }

  async purgeExpiredPrivacyResults(): Promise<number> {
    const result = await this.client.rpc('purge_expired_privacy_results', {});
    if (result.error) throw storageError(result.error);
    if (typeof result.data !== 'number') throw new Error('Privacy result purge returned an invalid count');
    return result.data;
  }

  async executeRestaurantPrivacyRequest(input: {
    actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
  }): Promise<PrivacyRequestRecord> {
    let removedRecordingPaths: string[] = [];
    if (input.requestType === 'delete') {
      const prepared = await this.client.rpc('prepare_restaurant_privacy_deletion', {
        p_actor_id: input.actorId, p_organization_id: input.organizationId, p_restaurant_id: input.restaurantId,
      });
      if (prepared.error) throw storageError(prepared.error);
      if (!Array.isArray(prepared.data) || prepared.data.some((path) => typeof path !== 'string')) throw new Error('Restaurant recording paths are malformed');
      removedRecordingPaths = prepared.data as string[];
      await this.removeRecordings(removedRecordingPaths);
    }
    const result = await this.client.rpc('execute_restaurant_privacy_request', {
      p_actor_id: input.actorId, p_organization_id: input.organizationId,
      p_restaurant_id: input.restaurantId, p_request_type: input.requestType,
      p_removed_recording_paths: removedRecordingPaths,
    });
    if (result.error) throw storageError(result.error);
    return this.withSignedRecordings(privacyRequestRecord(result.data));
  }

  async getOrganizationBilling(id: string): Promise<{id: string; name: string; stripeCustomerId: string | null} | null> {
    const result = await this.client.from('organizations').select('id,name,stripe_customer_id')
      .eq('id', id).maybeSingle();
    if (result.error) throw storageError(result.error);
    const row = result.data as {id?: unknown; name?: unknown; stripe_customer_id?: unknown} | null;
    if (!row) return null;
    if (typeof row.id !== 'string' || typeof row.name !== 'string') throw new Error('Organization billing row is malformed');
    return {id: row.id, name: row.name, stripeCustomerId: typeof row.stripe_customer_id === 'string' ? row.stripe_customer_id : null};
  }

  async getRestaurantIdForOrganization(id: string): Promise<string | null> {
    const result = await this.client.from('restaurants').select('id')
      .eq('organization_id', id).maybeSingle();
    if (result.error) throw storageError(result.error);
    const restaurantId = (result.data as {id?: unknown} | null)?.id;
    return typeof restaurantId === 'string' ? restaurantId : null;
  }

  async setOrganizationStripeCustomerId(id: string, customerId: string): Promise<void> {
    const result = await this.client.from('organizations').update({stripe_customer_id: customerId})
      .eq('id', id).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
  }

  async getRestaurantPaymentConnection(organizationId: string): Promise<{restaurantId: string; connectedAccountId: string | null} | null> {
    const result = await this.client.from('restaurants').select('id,stripe_connected_account_id')
      .eq('organization_id', organizationId).maybeSingle();
    if (result.error) throw storageError(result.error);
    const value = result.data as {id?: unknown; stripe_connected_account_id?: unknown} | null;
    if (!value) return null;
    if (typeof value.id !== 'string') throw new Error('Restaurant payment connection row is malformed');
    return {
      restaurantId: value.id,
      connectedAccountId: typeof value.stripe_connected_account_id === 'string'
        ? value.stripe_connected_account_id
        : null,
    };
  }

  async setRestaurantConnectedAccount(restaurantId: string, accountId: string | null): Promise<void> {
    const result = await this.client.from('restaurants').update({stripe_connected_account_id: accountId})
      .eq('id', restaurantId).select('id').maybeSingle();
    if (result.error) throw storageError(result.error);
    if (!result.data) throw new Error('Restaurant was not found');
  }

  async getPaymentTarget(input: {restaurantId: string; kind: 'order' | 'booking'; id: string}): Promise<PaymentTarget | null> {
    const restaurantResult = await this.client.from('restaurants')
      .select('id,stripe_connected_account_id,booking_deposit_cents')
      .eq('id', input.restaurantId).maybeSingle();
    if (restaurantResult.error) throw storageError(restaurantResult.error);
    const restaurant = restaurantResult.data as {
      id?: unknown; stripe_connected_account_id?: unknown; booking_deposit_cents?: unknown;
    } | null;
    if (!restaurant || typeof restaurant.id !== 'string') return null;
    const table = input.kind === 'order' ? 'orders' : 'bookings';
    const columns = input.kind === 'order'
      ? 'id,restaurant_id,total_cents,paid_status'
      : 'id,restaurant_id,paid_status';
    const targetResult = await this.client.from(table).select(columns)
      .eq('id', input.id).eq('restaurant_id', input.restaurantId).maybeSingle();
    if (targetResult.error) throw storageError(targetResult.error);
    const target = targetResult.data as {id?: unknown; restaurant_id?: unknown; total_cents?: unknown; paid_status?: unknown} | null;
    if (!target || typeof target.id !== 'string' || target.restaurant_id !== input.restaurantId) return null;
    const amountCents = input.kind === 'order' ? target.total_cents : restaurant.booking_deposit_cents;
    if (typeof amountCents !== 'number') throw new Error('Payment target amount is malformed');
    return {
      kind: input.kind,
      id: target.id,
      restaurantId: restaurant.id,
      amountCents,
      paidStatus: target.paid_status === 'paid' || target.paid_status === 'refunded' ? target.paid_status : 'unpaid',
      connectedAccountId: typeof restaurant.stripe_connected_account_id === 'string'
        ? restaurant.stripe_connected_account_id
        : null,
    };
  }

  async isDinerPaymentsEnabled(restaurantId: string): Promise<boolean> {
    const result = await this.client.rpc('is_diner_payments_enabled', {p_restaurant_id: restaurantId});
    if (result.error) throw storageError(result.error);
    return result.data === true;
  }
}

function privacyRequestRecord(value: unknown): PrivacyRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Privacy request mutation returned no row');
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    !['received', 'verified', 'fulfilling', 'completed', 'rejected'].includes(String(row.status)) ||
    !['export', 'delete'].includes(String(row.request_type)) ||
    !['required', 'verified', 'rejected'].includes(String(row.verification_status))
  ) throw new Error('Privacy request row is malformed');
  return {
    id: row.id,
    status: row.status as PrivacyRequestRecord['status'],
    requestType: row.request_type as PrivacyRequestRecord['requestType'],
    verification: row.verification_status as PrivacyRequestRecord['verification'],
    dueAt: typeof row.due_at === 'string' ? row.due_at : (() => { throw new Error('Privacy request due date is malformed'); })(),
    ...(row.result === null || row.result === undefined ? {} : {result: row.result}),
  };
}
