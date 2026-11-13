import {afterEach, expect, it, vi} from 'vitest';
import {BrowserAudioCall} from '@/lib/testcall/browser-audio';

class Source {
  buffer: unknown;
  onended: (() => void) | null = null;
  connect = vi.fn(); disconnect = vi.fn(); start = vi.fn(); stop = vi.fn();
}
class Context {
  static current: Context;
  sampleRate = 48000;
  currentTime = 10;
  state = 'running';
  destination = {};
  onstatechange: (() => void) | null = null;
  audioWorklet = {addModule: vi.fn(async () => {})};
  sources: Source[] = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {this.state = 'closed';});
  createMediaStreamSource = vi.fn(() => ({connect: vi.fn(), disconnect: vi.fn()}));
  createBuffer = vi.fn((_channels: number, samples: number) => ({getChannelData: () => new Float32Array(samples)}));
  createBufferSource = vi.fn(() => {const source = new Source(); this.sources.push(source); return source;});
  constructor() {Context.current = this;}
}
class Socket {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string | ArrayBuffer}) => void) | null = null;
  onclose = null; onerror = null;
  send = vi.fn(); close = vi.fn();
  constructor() {Socket.current = this;}
}
class Worklet {
  port = {onmessage: null, close: vi.fn()};
  onprocessorerror = null;
  connect = vi.fn(); disconnect = vi.fn();
}
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

it.each(['allocation', 'start'] as const)('reports a delayed native %s failure and releases the whole call', async (failure) => {
  vi.useFakeTimers();
  const track = {kind: 'audio', enabled: true, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn()};
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: async () => ({getTracks: () => [track]})}});
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => ({token: 'test-only-token', websocketUrl: 'wss://worker.example.test/browser-call'})})));
  const onError = vi.fn();
  const call = new BrowserAudioCall({onReady: vi.fn(), onError, onEnded: vi.fn()});
  await call.start('test-only-access-code');
  const socket = Socket.current, context = Context.current;
  socket.onopen?.();
  socket.onmessage?.({data: JSON.stringify({type: 'ready'})});
  for (let packet = 0; packet < 55; packet++) socket.onmessage?.({data: new ArrayBuffer(1280)});
  expect(onError).not.toHaveBeenCalled();
  if (failure === 'allocation') context.createBuffer.mockImplementationOnce(() => {throw new Error('Native audio allocation failed');});
  else context.createBufferSource.mockImplementationOnce(() => {
    const source = new Source();
    source.start.mockImplementation(() => {throw new Error('Native scheduling failed');});
    source.stop.mockImplementation(() => {throw new Error('Source never started');});
    context.sources.push(source);
    return source;
  });
  context.currentTime += 0.08;
  try {
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.sources.every((source) => source.disconnect.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    context.sources.forEach((source) => source.stop.mockReset());
    call.stop();
  }
});
