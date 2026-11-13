import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BrowserAudioCall, createPcmEncoder, createResampler, decodePcm16, encodePcm16, PcmPlayback} from '@/lib/testcall/browser-audio';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PCM framing and streaming resampling', () => {
  it('clips and serializes signed PCM16 explicitly little endian', () => {
    const encoded = encodePcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]));
    expect([...new Uint8Array(encoded)]).toEqual([0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127, 0, 0]);
    expect([...decodePcm16(new Uint8Array([0, 128, 0, 192, 0, 0, 0, 64]).buffer)]).toEqual([-1, -0.5, 0, 0.5]);
    expect(() => decodePcm16(new ArrayBuffer(3))).toThrow(/PCM/i);
  });

  it('averages native-rate samples rather than pretending capture already runs at 16 kHz', () => {
    const resample = createResampler(48000);
    expect([...resample(new Float32Array([0, 0, 0.75, 0, 0.75, 0.75]))]).toEqual([0.25, 0.5]);
    expect(() => createResampler(0)).toThrow();
  });

  it.each([44100, 48000])('keeps phase and exact sample count across irregular %i Hz chunks', (rate) => {
    const resample = createResampler(rate);
    const input = new Float32Array(rate).fill(0.5);
    const output: number[] = [];
    for (let offset = 0; offset < input.length; offset += 137) output.push(...resample(input.subarray(offset, offset + 137)));
    expect(output).toHaveLength(16000);
    expect(output.every((sample) => sample === 0.5)).toBe(true);
  });

  it.each([44100, 48000])('frames %i Hz capture into 20 ms packets, retaining partial packets', (rate) => {
    const encode = createPcmEncoder(rate);
    expect(encode(new Float32Array(100))).toEqual([]);
    const packets = encode(new Float32Array(rate - 100).fill(0.5));
    expect(packets).toHaveLength(50);
    expect(packets.every((packet) => packet.byteLength === 640)).toBe(true);
    expect(new DataView(packets[49]).getInt16(0, true)).toBe(16384);
  });
});

class FakeSource {
  buffer: {duration: number; samples: Float32Array} | null = null;
  onended: (() => void) | null = null;
  finished = false;
  connect = vi.fn(); disconnect = vi.fn(); stop = vi.fn(); start = vi.fn<(when: number) => void>();
}
class FakeContext {
  static instances: FakeContext[] = [];
  sampleRate = 48000;
  currentTime = 10;
  state = 'running';
  destination = {};
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  input = {connect: vi.fn(), disconnect: vi.fn()};
  audioWorklet = {addModule: vi.fn(async () => {})};
  resume = vi.fn(async () => { events.push('resume'); });
  close = vi.fn(async () => { this.state = 'closed'; });
  createMediaStreamSource = vi.fn(() => this.input);
  createBufferSource = () => { const source = new FakeSource(); this.sources.push(source); return source; };
  createBuffer = vi.fn((channels: number, length: number, rate: number) => {
    expect(channels).toBe(1);
    expect(rate).toBe(16000);
    const samples = new Float32Array(length);
    return {duration: length / rate, samples, getChannelData: () => samples};
  });
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const source of this.sources) {
      const start = source.start.mock.calls[0]?.[0];
      if (!source.finished && !source.stop.mock.calls.length && start !== undefined && start + source.buffer!.duration <= this.currentTime + 1e-9) {
        source.finished = true;
        source.onended?.();
      }
    }
  }
  constructor() { FakeContext.instances.push(this); events.push('context'); }
}
class FakeWorklet {
  static instances: FakeWorklet[] = [];
  port = {onmessage: null as null | ((event: {data: Float32Array}) => void), close: vi.fn()};
  onprocessorerror: (() => void) | null = null;
  connect = vi.fn(); disconnect = vi.fn();
  constructor(_context: unknown, public name: string) { FakeWorklet.instances.push(this); }
  capture(samples = new Float32Array(960).fill(0.5)) { this.port.onmessage?.({data: samples}); }
}
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: unknown}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn((data: string | ArrayBuffer) => { this.sent.push(data); });
  close = vi.fn(() => { this.readyState = 3; });
  constructor(public url: string) { FakeSocket.instances.push(this); events.push('socket'); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({data: typeof data === 'object' && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data}); }
}
let events: string[];
let stopTrack: ReturnType<typeof vi.fn>;
let capturedTrack: {kind: string; enabled: boolean; stop: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn>};
let fetchSession: ReturnType<typeof vi.fn>;
const latestContext = () => FakeContext.instances.at(-1)!;
const latestSocket = () => FakeSocket.instances.at(-1)!;
const latestWorklet = () => FakeWorklet.instances.at(-1)!;
const mediaStream = () => ({getTracks: () => [capturedTrack]});

// Drive the audio clock independently of JS timers; a stalled main thread can
// advance the former without delivering the latter.
function advancePlayback(context: FakeContext, milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 10) {
    context.advance(Math.min(10, milliseconds - elapsed) / 1000);
    vi.advanceTimersByTime(Math.min(10, milliseconds - elapsed));
  }
}

function orderedBurst(playback: Pick<PcmPlayback, 'enqueue'>, packets = 55) {
  const expected: number[] = [];
  for (let packet = 0; packet < packets; packet++) {
    const bytes = new ArrayBuffer(1280); // 40 ms at 16 kHz.
    const view = new DataView(bytes);
    for (let sample = 0; sample < 640; sample++) {
      const value = ((packet * 640 + sample) % 65536) - 32768;
      view.setInt16(sample * 2, value, true);
      expected.push(value / 32768);
    }
    playback.enqueue(bytes);
  }
  return expected;
}

function expectBoundedSchedule(context: FakeContext) {
  const live = context.sources.filter((source) => !source.disconnect.mock.calls.length && !source.stop.mock.calls.length);
  expect(live.length).toBeLessThanOrEqual(6);
  for (const source of live) {
    expect(source.start.mock.calls[0][0] + source.buffer!.duration - context.currentTime).toBeLessThanOrEqual(0.24 + 1e-9);
  }
}

function expectContinuousPcm(context: Pick<FakeContext, 'sources'>, expected: number[]) {
  const samples = context.sources.flatMap((source) => [...source.buffer!.samples]);
  expect(samples).toEqual(expected);
  for (let index = 1; index < context.sources.length; index++) {
    const previous = context.sources[index - 1];
    expect(context.sources[index].start.mock.calls[0][0]).toBeCloseTo(previous.start.mock.calls[0][0] + previous.buffer!.duration, 9);
  }
}

beforeEach(() => {
  events = [];
  FakeContext.instances = []; FakeWorklet.instances = []; FakeSocket.instances = [];
  stopTrack = vi.fn();
  capturedTrack = {kind: 'audio', enabled: true, stop: stopTrack, addEventListener: vi.fn(), removeEventListener: vi.fn()};
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: vi.fn(async () => { events.push('microphone'); return mediaStream(); })}});
  fetchSession = vi.fn(async () => { events.push('session'); return {ok: true, json: async () => ({token: 'short-lived-test-token', websocketUrl: 'wss://demo.example.test/audio'})}; });
  vi.stubGlobal('fetch', fetchSession);
});

describe('bounded PCM playback', () => {
  it('decodes at 16 kHz and schedules consecutive sources, then flushes all on clear', () => {
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    playback.enqueue(new Uint8Array([0, 128, 0, 64]).buffer);
    playback.enqueue(new ArrayBuffer(3200));
    expect(context.sources[0].buffer!.samples).toEqual(new Float32Array([-1, 0.5]));
    const firstStart = context.sources[0].start.mock.calls[0][0];
    expect(firstStart).toBeGreaterThanOrEqual(10);
    expect(context.sources[1].start).toHaveBeenCalledWith(firstStart + 2 / 16000);
    playback.clear();
    for (const source of context.sources) { expect(source.stop).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce(); }
    playback.enqueue(new ArrayBuffer(640));
    expect(context.sources.at(-1)!.start.mock.calls[0][0]).toBe(firstStart);
  });

  it('drains a 2.2 second ordered burst without losing samples or scheduling the whole burst', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    const expected = orderedBurst(playback);
    expect(context.sources[0].start.mock.calls[0][0]).toBeLessThanOrEqual(10.01);
    expectBoundedSchedule(context);
    expect(vi.getTimerCount()).toBe(1);
    for (let elapsed = 0; elapsed < 2300; elapsed += 10) {
      advancePlayback(context, 10);
      expectBoundedSchedule(context);
      if (elapsed === 2000) {
        expect(context.sources.some((source) => !source.finished)).toBe(true);
        expect(vi.getTimerCount()).toBe(0); // Stop pumping before the last source ends.
      }
    }
    expectContinuousPcm(context, expected);
    expect(context.sources.every((source) => source.finished)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const count = context.sources.length;
    advancePlayback(context, 1000);
    expect(context.sources).toHaveLength(count);
    playback.clear();
    expect(context.sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
  });

  it('accepts exactly five seconds, rejects true overflow before allocation and reclaims played capacity', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    for (let second = 0; second < 5; second++) playback.enqueue(new ArrayBuffer(32000));
    expectBoundedSchedule(context);
    const allocations = context.createBuffer.mock.calls.length;
    const sources = context.sources.length;
    expect(() => playback.enqueue(new ArrayBuffer(2))).toThrow(/slow|buffer|queue|behind/i);
    expect(context.createBuffer).toHaveBeenCalledTimes(allocations);
    expect(context.sources).toHaveLength(sources);
    advancePlayback(context, 1010);
    expect(() => playback.enqueue(new ArrayBuffer(32000))).not.toThrow();
    expect(() => playback.enqueue(new ArrayBuffer(640))).toThrow(/slow|buffer|queue|behind/i);
    advancePlayback(context, 5100);
    expectContinuousPcm(context, Array<number>(96000).fill(0));
    playback.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([3, 32001, 32002, 64000])('rejects malformed or oversized %i byte frames before allocation or source creation', (length) => {
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    playback.enqueue(new ArrayBuffer(0));
    expect(() => playback.enqueue(new ArrayBuffer(length))).toThrow();
    expect(context.createBuffer).not.toHaveBeenCalled();
    expect(context.sources).toHaveLength(0);
  });

  it('clears buffered speech and ignores stale timers and ended callbacks after fresh speech', () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    orderedBurst(playback);
    const staleTimer = timers.mock.calls.at(-1)![0] as () => void;
    const oldSources = [...context.sources];
    const staleEnded = oldSources[0].onended!;
    playback.clear();
    expect(vi.getTimerCount()).toBe(0);
    for (const source of oldSources) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.onended).toBeNull();
    }
    context.advance(1);
    const freshExpected = orderedBurst(playback, 10);
    const freshSources = context.sources.slice(oldSources.length);
    expect(freshSources[0].start.mock.calls[0][0]).toBeCloseTo(11.01, 9);
    const count = context.sources.length;
    staleTimer(); staleEnded();
    expect(context.sources).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(1);
    expect(oldSources[0].disconnect).toHaveBeenCalledOnce();
    advancePlayback(context, 500);
    expectContinuousPcm({sources: context.sources.slice(oldSources.length)}, freshExpected);
    expect(vi.getTimerCount()).toBe(0);
    playback.clear();
  });

  it('recovers after a main-thread stall without catching up by overlapping or dropping speech', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    playback.enqueue(new Uint8Array([0, 128]).buffer);
    context.advance(2.2); // Audio progresses while JS delivery/timers are stalled.
    const expected = orderedBurst(playback);
    expect(context.sources[1].start.mock.calls[0][0]).toBeCloseTo(12.21, 9);
    for (let elapsed = 0; elapsed < 2300; elapsed += 10) {
      advancePlayback(context, 10);
      expectBoundedSchedule(context);
    }
    expectContinuousPcm({sources: context.sources.slice(1)}, expected);
    expect(vi.getTimerCount()).toBe(0);
    playback.clear();
  });

  it('keeps normal paced long speech gapless without an idle playback timer', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    for (let packet = 0; packet < 250; packet++) {
      playback.enqueue(new ArrayBuffer(1280));
      expect(vi.getTimerCount()).toBe(0);
      advancePlayback(context, 40);
    }
    advancePlayback(context, 20);
    expectContinuousPcm(context, Array<number>(160000).fill(0));
    playback.clear();
  });

  it('resumes an already-buffered FIFO after its pump is stalled for 2.2 seconds', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    const expected = orderedBurst(playback);
    const scheduled = context.sources.length;
    const scheduledSamples = context.sources.reduce((sum, source) => sum + source.buffer!.samples.length, 0);
    expect(vi.getTimerCount()).toBe(1);
    context.currentTime += 2.2; // Neither the pending pump nor ended events run.
    vi.advanceTimersByTime(20);
    expect(context.sources[scheduled].start.mock.calls[0][0]).toBeCloseTo(12.21, 9);
    expectBoundedSchedule(context);
    for (let elapsed = 0; elapsed < 2100; elapsed += 10) {
      advancePlayback(context, 10);
      expectBoundedSchedule(context);
    }
    expect(context.sources.flatMap((source) => [...source.buffer!.samples])).toEqual(expected);
    expectContinuousPcm({sources: context.sources.slice(scheduled)}, expected.slice(scheduledSamples));
    expect(vi.getTimerCount()).toBe(0);
    playback.clear();
  });

  it('waits on the audio clock and bounds sources even when ended callbacks are delayed', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    const expected = orderedBurst(playback);
    const scheduled = context.sources.length;
    vi.advanceTimersByTime(2200); // A frozen audio clock must not consume FIFO samples.
    expect(context.sources).toHaveLength(scheduled);
    const delayedEnded = context.sources[0].onended!;
    for (let elapsed = 0; elapsed < 2300; elapsed += 10) {
      context.currentTime += 0.01; // Leave every ended event undelivered.
      vi.advanceTimersByTime(10);
      expect(context.sources.filter((source) => !source.disconnect.mock.calls.length).length).toBeLessThanOrEqual(6);
    }
    expectContinuousPcm(context, expected);
    delayedEnded(); // Clock-based retirement must be idempotent with late events.
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    playback.clear();
    expect(context.sources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('releases finished sources without stopping them again on clear', () => {
    const context = new FakeContext();
    const playback = new PcmPlayback(context as unknown as AudioContext);
    playback.enqueue(new ArrayBuffer(640));
    context.sources[0].onended?.();
    playback.clear();
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce();
    expect(context.sources[0].stop).not.toHaveBeenCalled();
  });
});

describe('browser call lifecycle', () => {
  function call() {
    const callbacks = {onReady: vi.fn(), onError: vi.fn(), onEnded: vi.fn()};
    return {audio: new BrowserAudioCall(callbacks), ...callbacks};
  }

  it('keeps a burst call alive and cancels buffered playback across hangup and a fresh call', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const first = call(); await first.audio.start('code');
    const socket = latestSocket(); socket.open(); socket.message({type: 'ready'});
    const context = latestContext();
    const staleMessage = socket.onmessage!;
    const expected = orderedBurst({enqueue: (bytes) => socket.message(bytes)});
    expect(first.onError).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expectBoundedSchedule(context);
    advancePlayback(context, 2300);
    expectContinuousPcm(context, expected);
    expect(first.onError).not.toHaveBeenCalled();
    expect(first.onEnded).not.toHaveBeenCalled();
    orderedBurst({enqueue: (bytes) => socket.message(bytes)});
    const stalePump = timers.mock.calls.at(-1)![0] as () => void;
    const staleEnded = context.sources.find((source) => !source.finished)!.onended!;
    first.audio.stop(); first.audio.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(context.close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    for (const source of context.sources.filter((source) => !source.finished)) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.onended).toBeNull();
    }
    const sourceCount = context.sources.length;
    const second = call(); await second.audio.start('code');
    const nextSocket = latestSocket(); nextSocket.open(); nextSocket.message({type: 'ready'});
    const nextContext = latestContext();
    expect(nextContext).not.toBe(context);
    orderedBurst({enqueue: (bytes) => nextSocket.message(bytes)}, 10);
    stalePump(); staleEnded(); staleMessage({data: new ArrayBuffer(1280)});
    expect(context.sources).toHaveLength(sourceCount);
    expect(context.sources.at(-1)!.disconnect).toHaveBeenCalledOnce();
    advancePlayback(nextContext, 500);
    expectContinuousPcm(nextContext, expected.slice(0, 6400));
    expect(nextContext.sources[0].start.mock.calls[0][0]).toBeLessThanOrEqual(10.01);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.onError).not.toHaveBeenCalled();
    expect(first.onEnded).not.toHaveBeenCalled();
    expect(second.onError).not.toHaveBeenCalled();
    expect(second.onEnded).not.toHaveBeenCalled();
    second.audio.stop();
    const secondCount = nextContext.sources.length;
    vi.advanceTimersByTime(10000);
    expect(nextContext.sources).toHaveLength(secondCount);
    expect(nextContext.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mutes the captured track, sends silence while muted, and re-enables it on unmute', async () => {
    const {audio} = call(); await audio.start('code');
    const socket = latestSocket(); socket.open(); socket.message({type: 'ready'});
    audio.setMuted(true);
    expect(capturedTrack.enabled).toBe(false);
    latestWorklet().capture();
    expect([...decodePcm16(socket.sent.at(-1) as ArrayBuffer)].every((sample) => sample === 0)).toBe(true);
    audio.setMuted(false);
    expect(capturedTrack.enabled).toBe(true);
    latestWorklet().capture();
    expect(decodePcm16(socket.sent.at(-1) as ArrayBuffer)[0]).toBe(0.5);
    audio.stop();
  });

  it('honours a mute set before permission resolves and ignores mute after stop', async () => {
    const {audio} = call();
    audio.setMuted(true);
    await audio.start('code');
    expect(capturedTrack.enabled).toBe(false);
    audio.stop();
    audio.setMuted(false);
    expect(capturedTrack.enabled).toBe(false);
  });

  it('reports real PCM RMS at most every 100 ms, stays quiet while muted, and ignores stale capture after stop', async () => {
    vi.useFakeTimers();
    const onMicLevel = vi.fn();
    const audio = new BrowserAudioCall({onReady: vi.fn(), onError: vi.fn(), onEnded: vi.fn(), onMicLevel});
    await audio.start('code');
    latestWorklet().capture();
    expect(onMicLevel).not.toHaveBeenCalled();
    latestSocket().open(); latestSocket().message({type: 'ready'});
    const capture = latestWorklet().port.onmessage!;
    latestWorklet().capture(new Float32Array([0.25, -0.25]));
    expect(onMicLevel).toHaveBeenLastCalledWith(0.25);
    latestWorklet().capture(new Float32Array(960).fill(0.75));
    await vi.advanceTimersByTimeAsync(99);
    latestWorklet().capture();
    expect(onMicLevel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    latestWorklet().capture(new Float32Array(960).fill(0.75));
    expect(onMicLevel).toHaveBeenLastCalledWith(0.75);
    audio.setMuted(true);
    await vi.advanceTimersByTimeAsync(100);
    latestWorklet().capture();
    expect(onMicLevel).toHaveBeenLastCalledWith(0);
    audio.stop();
    const count = onMicLevel.mock.calls.length;
    capture({data: new Float32Array(960).fill(1)});
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMicLevel).toHaveBeenCalledTimes(count);
  });

  it('unlocks on the gesture before any network work, authenticates first, and sends no capture until ready', async () => {
    const {audio, onReady} = call();
    const starting = audio.start('test-access');
    expect(events).toEqual(['context', 'resume']);
    await starting;
    expect(events).toEqual(['context', 'resume', 'microphone', 'session', 'socket']);
    expect(fetchSession).toHaveBeenCalledWith('/api/demo/session', expect.objectContaining({method: 'POST', body: JSON.stringify({accessCode: 'test-access'}), signal: expect.any(AbortSignal)}));
    expect(latestContext().audioWorklet.addModule).toHaveBeenCalledWith('/audio/pcm-capture.js');
    expect(latestWorklet().name).toBe('pcm-capture');
    const socket = latestSocket();
    expect(socket.binaryType).toBe('arraybuffer');
    latestWorklet().capture();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual(['{"type":"authenticate","token":"short-lived-test-token"}']);
    latestWorklet().capture();
    expect(socket.sent).toHaveLength(1);
    socket.message({type: 'ready'});
    expect(onReady).toHaveBeenCalledOnce();
    latestWorklet().capture();
    expect((socket.sent[1] as ArrayBuffer).byteLength).toBe(640);
    expect(new DataView(socket.sent[1] as ArrayBuffer).getInt16(0, true)).toBe(16384);
    audio.stop();
  });

  it('plays only ready audio, clears interruption sources, and releases every resource on stop', async () => {
    const {audio} = call();
    await audio.start('code');
    const socket = latestSocket(); socket.open();
    socket.message(new ArrayBuffer(640));
    expect(latestContext().sources).toHaveLength(0);
    socket.message({type: 'ready'});
    socket.message(new ArrayBuffer(640));
    socket.message({type: 'clear'});
    expect(latestContext().sources[0].stop).toHaveBeenCalledOnce();
    socket.message(new ArrayBuffer(640));
    audio.stop(); audio.stop();
    expect(latestContext().sources[1].stop).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(latestContext().close).toHaveBeenCalledOnce();
    expect(latestContext().input.disconnect).toHaveBeenCalledOnce();
    expect(latestWorklet().disconnect).toHaveBeenCalledOnce();
    expect(latestWorklet().port.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.onmessage).toBeNull();
  });

  it.each([[401, /access code/i], [429, /busy/i], [503, /offline/i]])('surfaces HTTP %i and cleans up the microphone', async (status, message) => {
    fetchSession.mockResolvedValue({ok: false, status});
    const {audio, onError} = call();
    await audio.start('code');
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(latestContext().close).toHaveBeenCalledOnce();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('bounds websocket buffering and terminates rather than accumulating stale audio', async () => {
    const {audio, onError} = call(); await audio.start('code');
    const socket = latestSocket(); socket.open(); socket.message({type: 'ready'});
    socket.bufferedAmount = 8000;
    latestWorklet().capture();
    expect(socket.sent).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/network|slow/i));
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it.each(['error', 'close', 'processor', 'invalid', 'server', 'suspended'])('terminates cleanly on %s', async (failure) => {
    vi.useFakeTimers();
    const {audio, onError} = call(); await audio.start('code');
    const socket = latestSocket(); socket.open(); socket.message({type: 'ready'});
    if (failure === 'error') socket.onerror?.();
    if (failure === 'close') socket.onclose?.();
    if (failure === 'processor') latestWorklet().onprocessorerror?.();
    if (failure === 'invalid') socket.message('not-json');
    if (failure === 'server') socket.message({type: 'error', message: 'Demo busy; try again.'});
    if (failure === 'suspended') { latestContext().state = 'suspended'; latestContext().onstatechange?.(); }
    expect(onError).toHaveBeenCalledOnce();
    if (failure === 'error') {
      const message = onError.mock.calls[0][0];
      expect(message).toMatch(/reload this page.*re-enter.*code.*tap Start call/i);
      expect(message).toMatch(/persists.*Chrome on Android.*Safari on iPhone/i);
      expect(message).not.toMatch(/offline|outage|tunnel|deployment|expired/i);
    }
    if (failure === 'server') expect(onError).toHaveBeenCalledWith('Demo busy; try again.');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(latestContext().close).toHaveBeenCalledOnce();
    expect(latestContext().input.disconnect).toHaveBeenCalledOnce();
    expect(latestWorklet().disconnect).toHaveBeenCalledOnce();
    expect(latestWorklet().port.close).toHaveBeenCalledOnce();
    expect(latestWorklet().port.onmessage).toBeNull();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates five attempts across network errors, remote close and stop, releasing resources despite delayed old callbacks', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const delayed: (() => void)[] = [];
    const releasedChecks: (() => void)[] = [];

    for (const [index, ending] of ['error', 'close', 'stop', 'error', 'stop'].entries()) {
      const tracks = Array.from({length: 2}, () => ({
        kind: 'audio', enabled: true, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      }));
      vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: vi.fn(async () => ({getTracks: () => tracks}))}});
      const current = call();
      await current.audio.start('code');
      const context = latestContext();
      const socket = latestSocket();
      const worklet = latestWorklet();
      const signal = fetchSession.mock.calls[index][1].signal as AbortSignal;
      const oldOpen = socket.onopen!;
      const oldMessage = socket.onmessage!;
      const oldError = socket.onerror!;
      const oldClose = socket.onclose!;
      const oldCapture = worklet.port.onmessage!;
      const oldProcessorError = worklet.onprocessorerror!;
      const oldStateChange = context.onstatechange!;
      const oldTrackEnded = tracks.map((track) => track.addEventListener.mock.calls[0][1] as () => void);

      // Deliver queued callbacks from every earlier attempt during connection.
      for (const replay of delayed) replay();
      expect(current.onReady).not.toHaveBeenCalled();
      expect(current.onError).not.toHaveBeenCalled();
      expect(current.onEnded).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);

      // The first network error occurs before open; later attempts play audio.
      if (index > 0) {
        socket.open(); socket.message({type: 'ready'});
        orderedBurst({enqueue: (bytes) => socket.message(bytes)}, 10);
        const oldPump = timers.mock.calls.at(-1)![0] as () => void;
        const oldEnded = context.sources.map((source) => source.onended!);
        const sourceCount = context.sources.length;
        for (const replay of delayed) replay();
        worklet.capture();
        expect(socket.sent).toHaveLength(2); // Authentication and fresh mic PCM.
        expect(decodePcm16(socket.sent[1] as ArrayBuffer)[0]).toBe(0.5);
        expect(current.onReady).toHaveBeenCalledOnce();
        expect(current.onError).not.toHaveBeenCalled();
        expect(current.onEnded).not.toHaveBeenCalled();
        expect(context.sources).toHaveLength(sourceCount);
        expect(context.sources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
        expect(vi.getTimerCount()).toBe(2); // Call limit and pending playback.
        delayed.push(() => { oldPump(); for (const ended of oldEnded) ended(); });
      }
      expect(socket.close).not.toHaveBeenCalled();
      expect(context.close).not.toHaveBeenCalled();
      for (const track of tracks) expect(track.stop).not.toHaveBeenCalled();

      delayed.push(() => {
        oldOpen();
        oldMessage({data: JSON.stringify({type: 'ready'})});
        oldMessage({data: new ArrayBuffer(1280)});
        oldMessage({data: JSON.stringify({type: 'clear'})});
        oldMessage({data: JSON.stringify({type: 'error', message: 'Late server error'})});
        oldCapture({data: new Float32Array(960).fill(1)});
        oldError(); oldClose(); oldProcessorError(); oldStateChange();
        for (const ended of oldTrackEnded) ended();
      });
      if (ending === 'error') socket.onerror!();
      if (ending === 'close') { socket.readyState = 3; socket.onclose!(); }
      current.audio.stop(); current.audio.stop();

      const sourceCount = context.sources.length;
      const sentCount = socket.sent.length;
      releasedChecks.push(() => {
        expect(current.onError).toHaveBeenCalledTimes(ending === 'stop' ? 0 : 1);
        expect(current.onReady).toHaveBeenCalledTimes(index === 0 ? 0 : 1);
        expect(current.onEnded).not.toHaveBeenCalled();
        expect(signal.aborted).toBe(true);
        for (const track of tracks) {
          expect(track.stop).toHaveBeenCalledOnce();
          expect(track.removeEventListener).toHaveBeenCalledExactlyOnceWith('ended', track.addEventListener.mock.calls[0][1]);
        }
        expect(context.close).toHaveBeenCalledOnce();
        expect(context.onstatechange).toBeNull();
        expect(context.input.disconnect).toHaveBeenCalledOnce();
        expect(worklet.disconnect).toHaveBeenCalledOnce();
        expect(worklet.port.close).toHaveBeenCalledOnce();
        expect(worklet.port.onmessage).toBeNull();
        expect(worklet.onprocessorerror).toBeNull();
        expect(socket.close).toHaveBeenCalledOnce();
        expect(socket.onopen).toBeNull();
        expect(socket.onmessage).toBeNull();
        expect(socket.onerror).toBeNull();
        expect(socket.onclose).toBeNull();
        expect(socket.sent).toHaveLength(sentCount);
        expect(context.sources).toHaveLength(sourceCount);
        for (const source of context.sources) {
          expect(source.stop).toHaveBeenCalledOnce();
          expect(source.disconnect).toHaveBeenCalledOnce();
          expect(source.onended).toBeNull();
        }
      });
      for (const replay of delayed) replay();
      await vi.advanceTimersByTimeAsync(600001);
      for (const checkReleased of releasedChecks) checkReleased();
      expect(vi.getTimerCount()).toBe(0);
      expect(FakeSocket.instances).toHaveLength(index + 1);
      expect(FakeContext.instances).toHaveLength(index + 1);
      expect(FakeWorklet.instances).toHaveLength(index + 1);
      expect(fetchSession).toHaveBeenCalledTimes(index + 1);
    }
  });

  it('times out a socket that never becomes ready at 15 seconds', async () => {
    vi.useFakeTimers();
    const {audio, onError} = call(); await audio.start('code'); latestSocket().open();
    await vi.advanceTimersByTimeAsync(14999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('does not announce listening when iOS interrupted audio before the ready message', async () => {
    const {audio, onReady, onError} = call(); await audio.start('code');
    const socket = latestSocket(); socket.open();
    latestContext().state = 'suspended'; latestContext().onstatechange?.();
    socket.message({type: 'ready'});
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/interrupted|Safari/i));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(latestContext().close).toHaveBeenCalledOnce();
  });

  it('ends a ready call after ten minutes and cancels the connect timer', async () => {
    vi.useFakeTimers();
    const {audio, onError, onEnded} = call(); await audio.start('code'); latestSocket().open(); latestSocket().message({type: 'ready'});
    await vi.advanceTimersByTimeAsync(599999);
    expect(onError).not.toHaveBeenCalled(); expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEnded).toHaveBeenCalledWith(expect.stringMatching(/10.minute/i));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a microphone granted after cancellation without opening a socket', async () => {
    let grant!: (stream: unknown) => void;
    vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: () => new Promise((resolve) => { grant = resolve; })}});
    const {audio, onReady, onError} = call();
    const starting = audio.start('code');
    await Promise.resolve(); audio.stop(); grant(mediaStream()); await starting;
    expect(stopTrack).toHaveBeenCalledOnce(); expect(FakeSocket.instances).toHaveLength(0);
    expect(onReady).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  });

  it('aborts a pending session request on stop and ignores a late result', async () => {
    let complete!: (value: unknown) => void;
    fetchSession.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const {audio} = call(); const starting = audio.start('code');
    await vi.waitFor(() => expect(fetchSession).toHaveBeenCalledOnce());
    const signal = fetchSession.mock.calls[0][1].signal;
    audio.stop();
    expect(signal.aborted).toBe(true);
    complete({ok: true, json: async () => ({token: 'late', websocketUrl: 'wss://demo.example.test'})});
    await starting;
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('reports microphone permission denial with a useful mobile recovery', async () => {
    vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); }}});
    const {audio, onError} = call(); await audio.start('code');
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/microphone.*permission/i));
    expect(onError.mock.calls[0][0]).toMatch(/Safari|settings/i);
    expect(latestContext().close).toHaveBeenCalledOnce();
  });

  it('rejects insecure pages and unsupported worklets without requesting a microphone', async () => {
    vi.stubGlobal('isSecureContext', false);
    const first = call(); await first.audio.start('code');
    expect(first.onError).toHaveBeenCalledWith(expect.stringMatching(/HTTPS/i));
    vi.stubGlobal('isSecureContext', true); vi.stubGlobal('AudioWorkletNode', undefined);
    const second = call(); await second.audio.start('code');
    expect(second.onError).toHaveBeenCalledWith(expect.stringMatching(/Safari|browser/i));
    expect(events).not.toContain('microphone');
  });
});

describe('self-hosted capture worklet', () => {
  it('downmixes stereo, batches 20 ms using the native rate, transfers samples and outputs silence', () => {
    let Processor!: new () => {process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean};
    const postMessage = vi.fn();
    runInNewContext(readFileSync(new URL('../public/audio/pcm-capture.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class {port = {postMessage};}, sampleRate: 44100,
      registerProcessor: (name: string, implementation: typeof Processor) => { expect(name).toBe('pcm-capture'); Processor = implementation; },
    });
    const worklet = new Processor();
    const silentOutput = new Float32Array(128);
    for (let i = 0; i < 7; i++) expect(worklet.process([[new Float32Array(128).fill(1), new Float32Array(128)]], [[silentOutput]])).toBe(true);
    expect(postMessage).toHaveBeenCalledOnce();
    const [samples, transfer] = postMessage.mock.calls[0];
    expect(samples.length).toBe(882); expect(samples[0]).toBe(0.5); expect(samples[881]).toBe(0.5);
    expect(transfer).toEqual([samples.buffer]); expect([...silentOutput].every((value) => value === 0)).toBe(true);
    expect(worklet.process([[]], [[silentOutput]])).toBe(true);
  });
});
