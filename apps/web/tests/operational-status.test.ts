import {describe, expect, it} from 'vitest';

import {getOperationalStatus, isTransferOpen, resolveTransferWindow} from '@/lib/operations/status';

const now = new Date('2026-10-27T16:00:00.000Z'); // 12:00 America/Toronto

describe('operational status', () => {
  it('marks an agent paused when either the restaurant or agent is paused', () => {
    expect(getOperationalStatus({
      now, timeZone: 'America/Toronto', transferHours: {daily: '11:00-22:00'},
      restaurantPaused: true, agentEnabled: true, spendAllowed: true,
      lastInvoiceStatus: 'paid', stripeInvoiceEventCreatedAt: null,
    }).agentPaused).toBe(true);
    expect(getOperationalStatus({
      now, timeZone: 'America/Toronto', transferHours: {daily: '11:00-22:00'},
      restaurantPaused: false, agentEnabled: false, spendAllowed: true,
      lastInvoiceStatus: 'paid', stripeInvoiceEventCreatedAt: null,
    }).agentPaused).toBe(true);
  });

  it('keeps a failed payment in grace for exactly seven days then blocks calls', () => {
    const base = {
      timeZone: 'America/Toronto', transferHours: {daily: '11:00-22:00'},
      restaurantPaused: false, agentEnabled: true, spendAllowed: true,
      lastInvoiceStatus: 'payment_failed' as const,
      stripeInvoiceEventCreatedAt: '2026-10-20T16:00:00.000Z',
    };
    expect(getOperationalStatus({...base, now: new Date('2026-10-27T15:59:59.999Z')})).toMatchObject({paymentGrace: true, paymentBlocked: false});
    expect(getOperationalStatus({...base, now: new Date('2026-10-27T16:00:00.000Z')})).toMatchObject({paymentGrace: false, paymentBlocked: true});
  });

  it('fails closed when a failed-payment timestamp is in the future', () => {
    expect(getOperationalStatus({
      now, timeZone: 'America/Toronto', transferHours: {daily: '11:00-22:00'},
      restaurantPaused: false, agentEnabled: true, spendAllowed: true,
      lastInvoiceStatus: 'payment_failed', stripeInvoiceEventCreatedAt: '2026-10-27T16:00:01.000Z',
    })).toMatchObject({paymentGrace: false, paymentBlocked: true});
  });

  it('blocks calls at the spend cap independently of payment state', () => {
    expect(getOperationalStatus({
      now, timeZone: 'America/Toronto', transferHours: {daily: '11:00-22:00'},
      restaurantPaused: false, agentEnabled: true, spendAllowed: false,
      lastInvoiceStatus: 'paid', stripeInvoiceEventCreatedAt: null,
    }).spendBlocked).toBe(true);
  });

  it('detects closed transfer hours in the restaurant timezone', () => {
    expect(isTransferOpen(now, 'America/Toronto', {daily: '11:00-22:00'})).toBe(true);
    expect(isTransferOpen(now, 'America/Toronto', {start: '11:00', end: '22:00'})).toBe(true);
    expect(isTransferOpen(new Date('2026-10-27T03:00:00.000Z'), 'America/Toronto', {daily: '11:00-22:00'})).toBe(false);
  });

  it('supports transfer windows that cross midnight and fails closed on invalid rules', () => {
    expect(isTransferOpen(new Date('2026-10-27T05:00:00.000Z'), 'America/Toronto', {daily: '22:00-02:00'})).toBe(true);
    expect(isTransferOpen(new Date('2026-10-27T08:00:00.000Z'), 'America/Toronto', {daily: '22:00-02:00'})).toBe(false);
    expect(isTransferOpen(now, 'America/Toronto', {daily: 'invalid'})).toBe(false);
  });

  it('resolves both persisted and legacy transfer-hour shapes for forms and status', () => {
    expect(resolveTransferWindow({start: '10:00', end: '21:00'})).toEqual({start: '10:00', end: '21:00'});
    expect(resolveTransferWindow({daily: '11:00-22:00'})).toEqual({start: '11:00', end: '22:00'});
  });
});
