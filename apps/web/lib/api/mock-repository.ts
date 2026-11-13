import {randomUUID} from 'node:crypto';

import {getDataSource} from '@/lib/data';
import {markMockPaymentPaid} from '@/lib/data/mock';
import type {DataSource} from '@/lib/data/types';
import {isFlagEnabled} from '@/lib/feature-flags';

import type {ApiRepository, EventProvider, ManagedPhoneNumber, OrderedMutationResult, PaymentTarget, PrivacyRequestRecord} from './repository';

export const MOCK_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
export const MOCK_RESTAURANT_ID = '11111111-1111-4111-8111-111111111111';
export const MOCK_PHONE_ID = '33333333-3333-4333-8333-333333333333';

export class MockApiRepository implements ApiRepository {
  constructor(private readonly source: () => DataSource = getDataSource) {}
  async prepareRetention(): Promise<{recordingPaths: string[]; recordings: number; transcripts: number}> { return {recordingPaths: [], recordings: 0, transcripts: 0}; }
  async removeRecordings(): Promise<void> {}
  async completeRetention(): Promise<{recordings: number; transcripts: number}> { return {recordings: 0, transcripts: 0}; }
  async signedRecordingUrl(): Promise<string | null> { return null; }
  async signedRecordingPath(): Promise<string | null> { return null; }
  private readonly events = new Set<string>();
  private readonly jobs = new Map<string, Record<string, unknown>>();
  private readonly claimedJobs = new Set<string>();
  private readonly phones = new Map<string, ManagedPhoneNumber>([[MOCK_PHONE_ID, {
    id: MOCK_PHONE_ID, restaurantId: MOCK_RESTAURANT_ID, e164: '+14165550123',
    telnyxNumberId: 'telnyx-number-demo', status: 'active', forwardingVerifiedAt: null,
  }]]);
  private stripeCustomerId: string | null = null;
  private stripeConnectedAccountId: string | null = null;
  private readonly stripeAccountRestaurants = new Map<string, string>();
  private readonly privacyRequests = new Map<string, PrivacyRequestRecord>();

  async claimEvent(provider: EventProvider, eventId: string): Promise<boolean> {
    const key = `${provider}:${eventId}`;
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }
  async completeEvent(): Promise<void> {}
  async failEvent(): Promise<void> {}

  async createImportJob(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const job = {id: randomUUID(), ...input};
    this.jobs.set(String(job.id), job);
    return {...job};
  }
  async getImportJob(id: string): Promise<Record<string, unknown> | null> {
    const job = this.jobs.get(id);
    return job ? {...job} : null;
  }
  async updateImportJob(id: string, value: Record<string, unknown>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Import job not found');
    Object.assign(job, value);
  }
  async claimImportExtraction(id: string): Promise<boolean> {
    if (this.claimedJobs.has(id)) return false;
    this.claimedJobs.add(id);
    return true;
  }
  async saveImportReviewRows(): Promise<void> {}
  async findRestaurantOrganizationId(restaurantId: string): Promise<string | null> {
    return restaurantId === MOCK_RESTAURANT_ID ? MOCK_ORGANIZATION_ID : null;
  }
  async addSmsOptOut(): Promise<void> {}
  async removeSmsOptOut(): Promise<void> {}
  async findRestaurantIdByPhoneNumber(e164: string): Promise<string | null> {
    return [...this.phones.values()].some((phone) => phone.e164 === e164) ? MOCK_RESTAURANT_ID : null;
  }
  async updateSmsDelivery(): Promise<OrderedMutationResult> { return 'applied'; }
  async updateOrganizationBilling(stripeCustomerId: string | null): Promise<OrderedMutationResult> {
    if (stripeCustomerId) this.stripeCustomerId = stripeCustomerId;
    return 'applied';
  }
  async markPaymentPaid(accountId: string, kind: 'order' | 'booking', targetId: string): Promise<OrderedMutationResult> {
    if (this.stripeAccountRestaurants.get(accountId) !== MOCK_RESTAURANT_ID) return 'not_found';
    return markMockPaymentPaid(this.source(), kind, targetId);
  }
  async getPhoneNumber(id: string): Promise<ManagedPhoneNumber | null> {
    const phone = this.phones.get(id);
    return phone ? {...phone} : null;
  }
  async savePhoneNumber(value: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    this.phones.set(id, {
      id,
      restaurantId: String(value.restaurant_id),
      e164: String(value.e164),
      telnyxNumberId: String(value.telnyx_number_id),
      status: String(value.status),
      forwardingVerifiedAt: null,
    });
    return id;
  }
  async updatePhoneNumber(id: string, value: Record<string, unknown>): Promise<void> {
    const phone = this.phones.get(id);
    if (!phone) throw new Error('Phone number not found');
    if (typeof value.status === 'string') phone.status = value.status;
  }
  async finalizePhoneRelease(input: {phoneId: string}): Promise<void> {
    const phone = this.phones.get(input.phoneId);
    if (!phone) throw new Error('Phone number not found');
    phone.status = 'released';
  }
  async writeAudit(): Promise<void> {}
  async createPrivacyRequest(input: {requestType: 'export' | 'delete'}): Promise<PrivacyRequestRecord> {
    const record: PrivacyRequestRecord = {id: randomUUID(), status: 'received', requestType: input.requestType, verification: 'required', dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString()};
    this.privacyRequests.set(record.id, record);
    return {...record};
  }
  async transitionPrivacyRequest(input: {requestId: string; action: 'verify' | 'fulfill' | 'reject'; verificationMethod?: string; verificationReference?: string}): Promise<PrivacyRequestRecord> {
    const record = this.privacyRequests.get(input.requestId);
    if (!record) throw new Error('PRIVACY_REQUEST_NOT_FOUND');
    if (input.action === 'verify') {
      if (!input.verificationMethod || !input.verificationReference) throw new Error('VERIFICATION_EVIDENCE_REQUIRED');
      Object.assign(record, {status: 'verified', verification: 'verified'});
    }
    else if (input.action === 'reject') Object.assign(record, {status: 'rejected', verification: 'rejected'});
    else {
      if (record.verification !== 'verified') throw new Error('PRIVACY_REQUEST_NOT_VERIFIED');
      Object.assign(record, {status: 'completed', result: record.requestType === 'export' ? {bookings: [], orders: [], messages: [], calls: []} : {deleted: true}});
    }
    return {...record};
  }
  async listPrivacyRequests(): Promise<PrivacyRequestRecord[]> { return [...this.privacyRequests.values()].map((record) => ({...record})); }
  async purgeExpiredPrivacyResults(): Promise<number> { return 0; }
  async executeRestaurantPrivacyRequest(input: {requestType: 'export' | 'delete'}): Promise<PrivacyRequestRecord> {
    return {id: randomUUID(), status: 'completed', requestType: input.requestType, verification: 'verified', dueAt: new Date().toISOString(), result: {}};
  }
  async getOrganizationBilling(id: string): Promise<{id: string; name: string; stripeCustomerId: string | null} | null> {
    return id === MOCK_ORGANIZATION_ID
      ? {id, name: 'Harbour Table Group', stripeCustomerId: this.stripeCustomerId}
      : null;
  }
  async getRestaurantIdForOrganization(id: string): Promise<string | null> {
    return id === MOCK_ORGANIZATION_ID ? MOCK_RESTAURANT_ID : null;
  }
  async setOrganizationStripeCustomerId(id: string, customerId: string): Promise<void> {
    if (id !== MOCK_ORGANIZATION_ID) throw new Error('Organization not found');
    this.stripeCustomerId = customerId;
  }
  async getRestaurantPaymentConnection(organizationId: string): Promise<{restaurantId: string; connectedAccountId: string | null} | null> {
    return organizationId === MOCK_ORGANIZATION_ID
      ? {restaurantId: MOCK_RESTAURANT_ID, connectedAccountId: this.stripeConnectedAccountId}
      : null;
  }
  async setRestaurantConnectedAccount(restaurantId: string, accountId: string | null): Promise<void> {
    if (restaurantId !== MOCK_RESTAURANT_ID) throw new Error('Restaurant not found');
    if (accountId) this.stripeAccountRestaurants.set(accountId, restaurantId);
    this.stripeConnectedAccountId = accountId;
  }
  async getPaymentTarget(input: {restaurantId: string; kind: 'order' | 'booking'; id: string}): Promise<PaymentTarget | null> {
    if (input.restaurantId !== MOCK_RESTAURANT_ID) return null;
    const source = this.source();
    const restaurant = await source.getRestaurantById(input.restaurantId);
    const order = input.kind === 'order'
      ? (await source.listOrders()).find((row) => row.id === input.id && row.restaurantId === input.restaurantId)
      : undefined;
    const booking = input.kind === 'booking'
      ? (await source.listBookings()).find((row) => row.id === input.id && row.restaurantId === input.restaurantId)
      : undefined;
    const target = order ?? booking;
    if (!target) return null;
    return {
      kind: input.kind,
      id: input.id,
      restaurantId: input.restaurantId,
      amountCents: order?.totalCents ?? restaurant.bookingDepositCents,
      paidStatus: target.paidStatus,
      connectedAccountId: this.stripeConnectedAccountId,
    };
  }
  async isDinerPaymentsEnabled(restaurantId: string): Promise<boolean> {
    return isFlagEnabled('diner_payments', restaurantId, this.source());
  }
}

export const mockApiRepository = new MockApiRepository();
