import {describe, expect, it} from 'vitest';
import {buildSeed} from '@/lib/data/mock/seed';
import {createMockDataSource} from '@/lib/data/mock';
import {createSupabaseDataSource, type SupabaseClientLike} from '@/lib/data/supabase';
import {dataSourceContract} from './data-source-contract';

describe('shared DataSource contract: mock', () => {
  dataSourceContract(() => createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z')));
});

describe('shared DataSource contract: Supabase stub', () => {
  dataSourceContract(() => createSupabaseDataSource(createStatefulClient()));
});

describe('Supabase DataSource errors', () => {
  it('reads persisted legal settings and invoices and saves recording notice changes', async () => {
    const source = createSupabaseDataSource(createStatefulClient());

    expect(await source.getLegalSettings()).toMatchObject({
      recordingNotice: 'Persisted notice',
      recordingEnabled: true,
      transcriptEnabled: true,
      legalReviewRequired: true,
    });
    expect(await source.listInvoices()).toHaveLength(1);

    await source.updateLegalSettings({recordingNotice: 'Updated bilingual notice', recordingEnabled: false, transcriptEnabled: true});
    expect(await source.getLegalSettings()).toMatchObject({recordingNotice: 'Updated bilingual notice', recordingEnabled: false, transcriptEnabled: true});
  });

  it('surfaces PostgREST failures instead of returning partial data', async () => {
    const client = createStatefulClient();
    client.failNext('restaurants', 'permission denied');

    await expect(createSupabaseDataSource(client).getRestaurant()).rejects.toThrow('permission denied');
  });

  it('names UI-only operations that have no persistence model and reads admin audit rows through the narrow RPC', async () => {
    const source = createSupabaseDataSource(createStatefulClient());

    await expect(source.getOnboardingState()).rejects.toThrow('onboarding state is not defined by the Supabase schema');
    await expect(source.startImportJob('https://example.com')).rejects.toThrow('import jobs is not defined by the Supabase schema');
    await expect(source.listAuditLogs()).resolves.toEqual([]);
  });

  it('resolves the viewer role for the authenticated user rather than the first member', async () => {
    const source = createSupabaseDataSource(createStatefulClient('staff-user'));

    expect(await source.getViewerRole()).toBe('staff');
  });

  it('records bookings created by staff with a staff source', async () => {
    const source = createSupabaseDataSource(createStatefulClient('staff-user'));

    await expect(source.createBooking({
      name: 'Staff guest', phoneE164: '+14165550123', partySize: 2,
      startsAt: '2026-11-10T22:00:00.000Z', notes: '',
    })).resolves.toMatchObject({source: 'staff'});
  });
});

type Row = Record<string, unknown>;

interface StatefulClient extends SupabaseClientLike {
  failNext(table: string, message: string): void;
}

function createStatefulClient(currentUserId = 'owner-user'): StatefulClient {
  const seed = buildSeed();
  const tables = new Map<string, Row[]>([
    ['restaurants', [snake(seed.restaurant)]],
    ['organizations', [snake(seed.organization)]],
    ['memberships', [
      snake({...seed.memberships[0], userId: 'owner-user'}),
      snake({...seed.memberships[1], userId: 'staff-user'})
    ]],
    ['hours', seed.hours.map(snake)],
    ['hours_overrides', seed.hoursOverrides.map(snake)],
    ['menu_items', seed.menuItems.map(snake)],
    ['menu_modifiers', seed.menuModifiers.map(snake)],
    ['faqs', seed.faqs.map(snake)],
    ['agent_versions', seed.agentVersions.map(snake)],
    ['phone_numbers', [snake(seed.phoneNumber)]],
    ['calls', seed.calls.map(snake)],
    ['call_turns', seed.callTurns.map(snake)],
    ['call_metrics', seed.callMetrics.map(snake)],
    ['slots_config', [snake(seed.slotsConfig)]],
    ['bookings', seed.bookings.map(snake)],
    ['orders', seed.orders.map(snake)],
    ['order_items', seed.orderItems.map(snake)],
    ['messages', seed.messages.map(snake)],
    ['agents', [snake(seed.agent)]],
    ['usage_ledger', [snake(seed.usage)]],
    ['legal_settings', [snake({
      id: 'legal-1', restaurantId: seed.restaurant.id, recordingNotice: 'Persisted notice',
      legalReviewRequired: true, privacyPolicyUrl: 'https://example.com/privacy',
      recordingEnabled: true, transcriptEnabled: true,
    })]],
    ['invoices', [snake({
      id: 'invoice-1', organizationId: seed.organization.id, period: '2026-10',
      totalCents: 6900, status: 'paid', createdAt: '2026-10-27T12:00:00.000Z', updatedAt: '2026-10-27T12:00:00.000Z',
    })]]
  ]);
  const failures = new Map<string, string>();

  return {
    failNext(table, message) { failures.set(table, message); },
    from(table) { return new StubQuery(table, tables, failures); },
    auth: {
      getUser() { return Promise.resolve({data: {user: {id: currentUserId}}, error: null}); }
    },
    rpc(functionName, args = {}) {
      if (functionName === 'list_admin_audit_logs') {
        return Promise.resolve({data: tables.get('audit_log') ?? [], error: null});
      }
      if (functionName === 'get_legal_settings') {
        return Promise.resolve({data: tables.get('legal_settings')?.[0] ?? null, error: null});
      }
      if (functionName === 'update_legal_settings') {
        const settings = tables.get('legal_settings')?.[0];
        if (!settings) return Promise.resolve({data: null, error: {message: 'Legal settings not found'}});
        Object.assign(settings, {
          recording_notice: args.p_recording_notice,
          recording_enabled: args.p_recording_enabled,
          transcript_enabled: args.p_transcript_enabled,
        });
        return Promise.resolve({data: settings, error: null});
      }
      if (functionName === 'create_booking') {
        return Promise.resolve({data: insertRpcRow(tables, 'bookings', {
          restaurant_id: args.p_restaurant_id,
          call_id: null,
          name: args.p_name,
          phone_e164: args.p_phone_e164,
          party_size: args.p_party_size,
          starts_at: args.p_starts_at,
          status: 'confirmed',
          notes: args.p_notes,
          source: args.p_source ?? 'owner'
        }), error: null});
      }
      if (functionName === 'save_agent_draft') {
        const versions = tables.get('agent_versions') ?? [];
        const versionNo = Math.max(...versions.map((value) => Number(value.version_no))) + 1;
        const draft = insertRpcRow(tables, 'agent_versions', {
          agent_id: args.p_agent_id,
          version_no: versionNo,
          status: 'draft',
          prompt_sections: args.p_prompt_sections,
          voices: args.p_voices,
          rules: args.p_rules,
          published_at: null,
          published_by: null
        });
        return Promise.resolve({data: draft, error: null});
      }
      if (functionName === 'publish_agent_version') {
        const versions = tables.get('agent_versions') ?? [];
        for (const version of versions) if (version.status === 'published') version.status = 'archived';
        const published = versions.find((version) => version.id === args.p_version_id);
        if (!published) return Promise.resolve({data: null, error: {message: 'Agent version not found'}});
        published.status = 'published';
        return Promise.resolve({data: published, error: null});
      }
      if (functionName === 'restore_agent_version') {
        const versions = tables.get('agent_versions') ?? [];
        const source = versions.find((version) => version.id === args.p_version_id);
        if (!source) return Promise.resolve({data: null, error: {message: 'Agent version not found'}});
        for (const version of versions) if (version.status === 'draft') version.status = 'archived';
        return Promise.resolve({data: insertRpcRow(tables, 'agent_versions', {
          agent_id: source.agent_id,
          version_no: Math.max(...versions.map((value) => Number(value.version_no))) + 1,
          status: 'draft',
          prompt_sections: source.prompt_sections,
          voices: source.voices,
          rules: source.rules,
          published_at: null,
          published_by: null
        }), error: null});
      }
      return Promise.resolve({data: null, error: {message: `Unsupported RPC: ${functionName}`}});
    }
  };
}

function insertRpcRow(tables: Map<string, Row[]>, table: string, value: Row): Row {
  const rows = tables.get(table) ?? [];
  const timestamp = '2026-10-27T12:00:00.000Z';
  const row = {id: `${table}-${rows.length + 1}`, created_at: timestamp, updated_at: timestamp, ...value};
  rows.push(row);
  tables.set(table, rows);
  return row;
}

class StubQuery implements PromiseLike<{data: unknown; error: {message: string} | null}> {
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private values: Row | Row[] | undefined;
  private filters: Array<[string, unknown]> = [];
  private one: 'single' | 'maybeSingle' | undefined;

  constructor(
    private readonly table: string,
    private readonly tables: Map<string, Row[]>,
    private readonly failures: Map<string, string>
  ) {}

  select(): this { return this; }
  insert(values: unknown): this { this.action = 'insert'; this.values = values as Row | Row[]; return this; }
  update(values: unknown): this { this.action = 'update'; this.values = values as Row; return this; }
  delete(): this { this.action = 'delete'; return this; }
  eq(column: string, value: unknown): this { this.filters.push([column, value]); return this; }
  is(column: string, value: null | boolean): this { this.filters.push([column, value]); return this; }
  order(): this { return this; }
  limit(): this { return this; }
  single(): this { this.one = 'single'; return this; }
  maybeSingle(): this { this.one = 'maybeSingle'; return this; }

  then<TResult1 = {data: unknown; error: {message: string} | null}, TResult2 = never>(
    onfulfilled?: ((value: {data: unknown; error: {message: string} | null}) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{data: unknown; error: {message: string} | null}> {
    const failure = this.failures.get(this.table);
    if (failure) {
      this.failures.delete(this.table);
      return {data: null, error: {message: failure}};
    }
    const rows = this.tables.get(this.table) ?? [];
    const matches = (row: Row) => this.filters.every(([column, value]) => row[column] === value);
    let selected = rows.filter(matches);

    if (this.action === 'insert') {
      const incoming = (Array.isArray(this.values) ? this.values : [this.values]) as Row[];
      const now = '2026-10-27T12:00:00.000Z';
      selected = incoming.map((row, index) => ({
        id: row.id ?? `${this.table}-${rows.length + index + 1}`,
        created_at: row.created_at ?? now,
        updated_at: row.updated_at ?? now,
        ...row
      }));
      rows.push(...selected);
      this.tables.set(this.table, rows);
    } else if (this.action === 'update') {
      selected = selected.map((row) => Object.assign(row, this.values));
    } else if (this.action === 'delete') {
      this.tables.set(this.table, rows.filter((row) => !matches(row)));
    }

    const data = this.one === 'single'
      ? selected[0] ?? null
      : this.one === 'maybeSingle'
        ? selected[0] ?? null
        : selected;
    return {data, error: this.one === 'single' && !data ? {message: 'Row not found'} : null};
  }
}

function snake(value: object): Row {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), item]));
}
