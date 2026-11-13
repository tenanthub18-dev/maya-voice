// @vitest-environment jsdom
import React from 'react';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {BrowserCallCallbacks} from '@/lib/testcall/browser-audio';
import {BRAND, getProductName} from '@/lib/brand';

const calls = vi.hoisted(() => [] as {callbacks: BrowserCallCallbacks; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; setMuted: ReturnType<typeof vi.fn>}[]);
vi.mock('next-intl/server', () => ({getLocale: async () => 'en'}));
vi.mock('@/lib/testcall/browser-audio', () => ({
  BrowserAudioCall: class {
    start = vi.fn(async () => {});
    stop = vi.fn();
    setMuted = vi.fn();
    constructor(public callbacks: BrowserCallCallbacks) { calls.push(this); }
  },
}));
import BrowserDemoPage from '@/app/demo/page';
import {BrowserDemo} from '@/components/browser-demo';

beforeEach(() => { calls.length = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function start() {
  fireEvent.change(screen.getByLabelText(/^Access code/), {target: {value: 'private-test-code'}});
  fireEvent.click(screen.getByRole('button', {name: 'Start call'}));
  return calls.at(-1)!;
}

describe('restaurant browser demo', () => {
  it.each(['en', 'fr'])('discloses AI, saved text/usage and no audio before starting (%s)', (locale) => {
    render(<BrowserDemo locale={locale}/>);
    const text = screen.getByRole('main').textContent!;
    expect(text).toMatch(locale === 'en' ? /AI assistant/ : /assistant IA/);
    expect(text).toMatch(locale === 'en' ? /text and usage may be saved for review/ : /texte.*utilisation.*conservés.*examen/);
    expect(text).toMatch(locale === 'en' ? /audio is not stored/ : /audio n’est pas conservé/);
    expect(text).toMatch(locale === 'en' ? /orders and bookings are not saved/ : /commandes et réservations.*ne sont pas enregistrées/);
    expect(calls).toHaveLength(0);
  });

  it('renders /demo safely on the server with clear practice and language guidance', async () => {
    vi.stubGlobal('window', undefined); vi.stubGlobal('navigator', undefined);
    const html = renderToStaticMarkup(await BrowserDemoPage());
    expect(html).toContain('A table-side conversation.');
    expect(html).toContain(getProductName('en'));
    expect(html).toContain(BRAND.defaultPersonaName);
    expect(html).toContain('Private demo');
    expect(html).toMatch(/practice orders and bookings.*not saved/i);
    for (const language of ['English', 'French', 'Hindi', 'Urdu', 'Punjabi', 'Telugu', 'Arabic']) expect(html).toContain(language);
    expect(html).toMatch(/switch languages/i);
    expect(html).toContain('type="password"');
    expect(calls).toHaveLength(0);
  });

  it('requires an access code, prevents duplicate starts, waits for ready and ends a call', async () => {
    render(<BrowserDemo/>);
    expect(screen.getByRole('main')).toBeTruthy();
    expect((screen.getByRole('button', {name: 'Start call'}) as HTMLButtonElement).disabled).toBe(true);
    const current = start();
    expect(current.start).toHaveBeenCalledWith('private-test-code');
    expect(screen.getByRole('status').textContent).toMatch(/connecting/i);
    expect((screen.getByLabelText(/^Access code/) as HTMLInputElement).disabled).toBe(true);
    // A repeated form event before a render must not create another attempt.
    fireEvent.submit(screen.getByRole('button', {name: 'Cancel connection'}).closest('form')!);
    expect(calls).toHaveLength(1);
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toMatch(/connecting/i);
    act(() => current.callbacks.onReady());
    expect(screen.getByRole('status').textContent).toMatch(/listening/i);
    fireEvent.click(screen.getByRole('button', {name: 'End call'}));
    expect(current.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toMatch(/ended/i);
    expect((screen.getByRole('button', {name: 'Start call'}) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows transport errors accessibly and permits a fresh attempt', () => {
    render(<BrowserDemo/>);
    const current = start();
    act(() => current.callbacks.onError('The practice line is busy. Try again shortly.'));
    expect(screen.getByRole('alert').textContent).toMatch(/busy/i);
    fireEvent.click(screen.getByRole('button', {name: 'Start call'}));
    expect(calls).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => current.callbacks.onReady());
    expect(screen.getByRole('status').textContent).toMatch(/connecting/i);
    act(() => calls[1].callbacks.onEnded('The 10-minute practice call has ended.'));
    expect(screen.getByRole('status').textContent).toMatch(/10-minute/i);
  });

  it('stops pending or active calls on unmount and ignores late callbacks', () => {
    const view = render(<BrowserDemo/>);
    const current = start();
    view.unmount();
    expect(current.stop).toHaveBeenCalledOnce();
    act(() => { current.callbacks.onReady(); current.callbacks.onError('late error'); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the app locale for French call controls and practice guidance', () => {
    render(<BrowserDemo locale="fr-CA"/>);
    expect(screen.getByRole('button', {name: 'Démarrer l’appel'})).toBeTruthy();
    expect(screen.getByLabelText(/^Code d’accès/)).toBeTruthy();
    expect(screen.getByText(/ne sont pas enregistrées/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Code d’accès/), {target: {value: 'code-test'}});
    fireEvent.click(screen.getByRole('button', {name: 'Démarrer l’appel'}));
    act(() => calls[0].callbacks.onReady());
    expect(screen.getByRole('button', {name: 'Couper le microphone'})).toBeTruthy();
    act(() => calls[0].callbacks.onEnded('The 10-minute practice call has ended.'));
    expect(screen.getByRole('status').textContent).toMatch(/10 minutes est terminé/);
  });

  it('starts elapsed time only when ready, stops it on hang-up, and resets on reconnect', () => {
    vi.useFakeTimers();
    render(<BrowserDemo/>);
    const current = start();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('timer')).toBeNull();
    act(() => current.callbacks.onReady());
    act(() => current.callbacks.onReady());
    expect(vi.getTimerCount()).toBe(1);
    expect(screen.getByRole('timer').textContent).toBe('00:00');
    act(() => vi.advanceTimersByTime(65000));
    expect(screen.getByRole('timer').textContent).toBe('01:05');
    fireEvent.click(screen.getByRole('button', {name: 'End call'}));
    expect(screen.queryByRole('timer')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10000));
    fireEvent.click(screen.getByRole('button', {name: 'Start call'}));
    act(() => calls[1].callbacks.onReady());
    expect(screen.getByRole('timer').textContent).toBe('00:00');
  });

  it('wires mute and unmute to the call, showing microphone activity only for current captured PCM', () => {
    render(<BrowserDemo/>);
    const meter = screen.getByRole('meter', {name: 'Microphone activity'});
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    const current = start();
    expect(screen.queryByRole('button', {name: 'Mute microphone'})).toBeNull();
    act(() => current.callbacks.onReady());
    act(() => current.callbacks.onMicLevel?.(0.25));
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    fireEvent.click(screen.getByRole('button', {name: 'Mute microphone'}));
    expect(current.setMuted).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', {name: 'Unmute microphone'}).getAttribute('aria-pressed')).toBe('true');
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.click(screen.getByRole('button', {name: 'Unmute microphone'}));
    expect(current.setMuted).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', {name: 'Mute microphone'}).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', {name: 'End call'}));
    act(() => current.callbacks.onMicLevel?.(0.9));
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
  });

  it('cancels connection and clears timers on remote end, error and unmount', () => {
    vi.useFakeTimers();
    const view = render(<BrowserDemo/>);
    const first = start();
    fireEvent.click(screen.getByRole('button', {name: 'Cancel connection'}));
    expect(first.stop).toHaveBeenCalledOnce();
    act(() => first.callbacks.onReady());
    expect(screen.queryByRole('timer')).toBeNull();
    for (const outcome of ['ended', 'error', 'unmount']) {
      fireEvent.click(screen.getByRole('button', {name: 'Start call'}));
      const current = calls.at(-1)!;
      act(() => current.callbacks.onReady());
      expect(vi.getTimerCount()).toBe(1);
      if (outcome === 'ended') act(() => current.callbacks.onEnded('The 10-minute practice call has ended.'));
      if (outcome === 'error') act(() => current.callbacks.onError('The line closed.'));
      if (outcome === 'unmount') view.unmount();
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.queryByRole('timer')).toBeNull();
    }
  });
});
