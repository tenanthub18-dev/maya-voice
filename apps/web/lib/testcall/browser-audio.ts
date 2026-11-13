const PCM_RATE = 16000;
const PACKET_SAMPLES = 320; // 20 ms, 640 bytes of mono PCM16.
const MAX_SEND_BYTES = 8000; // At most 250 ms queued on the network.
const MAX_PLAYBACK_SAMPLES = 5 * PCM_RATE; // 160 KB of mono PCM16, pending + scheduled.
const PLAYBACK_LOOKAHEAD_SECONDS = 0.2;
const PLAYBACK_CHUNK_SAMPLES = 640; // At most 40 ms per native source, even for large frames.
const PLAYBACK_PUMP_MS = 20;

export function encodePcm16(samples: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(samples.length * 2);
  const view = new DataView(bytes);
  samples.forEach((value, index) => {
    const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  return bytes;
}

export function decodePcm16(bytes: ArrayBuffer): Float32Array<ArrayBuffer> {
  if (bytes.byteLength % 2) throw new Error('Invalid PCM16 audio frame.');
  const view = new DataView(bytes);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

// Integrate sample areas across output intervals. Integer phase units preserve
// 44.1/48 kHz timing across arbitrary worklet chunks without boundary gaps.
export function createResampler(inputRate: number): (input: Float32Array) => Float32Array {
  if (!Number.isInteger(inputRate) || inputRate <= 0) throw new Error('Invalid microphone sample rate.');
  let filled = 0;
  let sum = 0;
  return (input) => {
    const output: number[] = [];
    for (const sample of input) {
      let remaining = PCM_RATE;
      while (remaining > 0) {
        const weight = Math.min(remaining, inputRate - filled);
        sum += sample * weight;
        remaining -= weight;
        filled += weight;
        if (filled === inputRate) {
          output.push(sum / inputRate);
          filled = 0;
          sum = 0;
        }
      }
    }
    return new Float32Array(output);
  };
}

export function createPcmEncoder(inputRate: number): (input: Float32Array) => ArrayBuffer[] {
  const resample = createResampler(inputRate);
  const packet = new Float32Array(PACKET_SAMPLES);
  let offset = 0;
  return (input) => {
    const packets: ArrayBuffer[] = [];
    for (const sample of resample(input)) {
      packet[offset++] = sample;
      if (offset === packet.length) {
        packets.push(encodePcm16(packet));
        offset = 0;
      }
    }
    return packets;
  };
}

// Keep delivery bursts as PCM in a FIFO; only decode a short audio-clock window.
// Sources are single-use and retained for interruption:
// https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode
// Schedule against the audio timeline, independently of JS timer delivery:
// https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime
export class PcmPlayback {
  private nextTime = 0;
  private sources = new Map<AudioBufferSourceNode, {start: number; samples: number}>();
  private pending: {bytes: ArrayBuffer; offset: number}[] = [];
  private pendingSamples = 0;
  private pumpTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(private context: AudioContext, private onError?: (error: unknown) => void) {}

  enqueue(bytes: ArrayBuffer): void {
    if (!bytes.byteLength) return;
    // Reject malformed frames, >1-second frames and true overflow before any
    // decoding, AudioBuffer allocation or source creation. Count audio samples,
    // not the initial scheduling lead, so exactly five seconds fits.
    if (bytes.byteLength % 2 || bytes.byteLength > 2 * PCM_RATE) throw new Error('Invalid PCM16 audio frame.');
    const samples = bytes.byteLength / 2;
    const now = this.context.currentTime;
    let queued = this.pendingSamples;
    for (const scheduled of this.sources.values()) {
      const played = Math.max(0, Math.floor((now - scheduled.start) * PCM_RATE + 1e-6));
      queued += Math.max(0, scheduled.samples - played);
    }
    if (queued + samples > MAX_PLAYBACK_SAMPLES) {
      throw new Error('Audio playback is too far behind. End the call and try a faster connection.');
    }
    this.pending.push({bytes, offset: 0});
    this.pendingSamples += samples;
    this.pump();
  }

  private pump(): void {
    const now = this.context.currentTime;
    // Ended events can be delayed by the same main-thread stall as delivery.
    for (const [source, scheduled] of this.sources) {
      if (scheduled.start + scheduled.samples / PCM_RATE <= now) {
        source.onended = null;
        source.disconnect();
        this.sources.delete(source);
      }
    }
    while (this.pending.length && this.nextTime < now + PLAYBACK_LOOKAHEAD_SECONDS) {
      const frame = this.pending[0];
      const samples = Math.min(PLAYBACK_CHUNK_SAMPLES, (frame.bytes.byteLength - frame.offset) / 2);
      const buffer = this.context.createBuffer(1, samples, PCM_RATE);
      const output = buffer.getChannelData(0);
      const view = new DataView(frame.bytes, frame.offset, samples * 2);
      for (let index = 0; index < samples; index++) output[index] = view.getInt16(index * 2, true) / 32768;
      const source = this.context.createBufferSource();
      // Add a small lead only on underrun; consecutive chunks share an exact
      // boundary, with no time stretching, dropping or jitter warmup.
      const start = this.nextTime > now ? this.nextTime : now + 0.01;
      const generation = this.generation;
      source.onended = () => {
        if (generation === this.generation && this.sources.delete(source)) source.disconnect();
      };
      this.sources.set(source, {start, samples});
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.start(start);
      this.nextTime = start + samples / PCM_RATE;
      frame.offset += samples * 2;
      this.pendingSamples -= samples;
      if (frame.offset === frame.bytes.byteLength) this.pending.shift();
    }
    if (this.pending.length && this.pumpTimer === undefined) {
      const generation = this.generation;
      this.pumpTimer = setTimeout(() => {
        if (generation !== this.generation) return;
        this.pumpTimer = undefined;
        try { this.pump(); }
        catch (error) {
          this.clear();
          this.onError?.(error);
        }
      }, PLAYBACK_PUMP_MS);
    } else if (!this.pending.length) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }

  clear(): void {
    this.generation++;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.pending = [];
    this.pendingSamples = 0;
    for (const source of this.sources.keys()) {
      source.onended = null;
      // A native start failure leaves an owned source that cannot be stopped.
      // Still disconnect it and release every other source and call resource.
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    this.sources.clear();
    this.nextTime = 0;
  }
}

export interface BrowserCallCallbacks {
  onReady: () => void;
  onError: (message: string) => void;
  onEnded: (message: string) => void;
  onMicLevel?: (level: number) => void;
}

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied. Allow microphone access in browser settings, then tap Start call. On iPhone, open this page in Safari.';
  }
  if (name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.';
  if (name === 'NotReadableError') return 'Your microphone is in use or unavailable. Close other calls and try again.';
  return error instanceof Error ? error.message : 'Could not start the voice demo. Please try again.';
}

// This instance owns exactly one attempt, including requests that resolve after
// stop. No browser globals are accessed until start() runs in the tap handler.
export class BrowserAudioCall {
  private started = false;
  private stopped = false;
  private ready = false;
  private muted = false;
  private lastMicLevelAt = -Infinity;
  private encode?: ReturnType<typeof createPcmEncoder>;
  private context?: AudioContext;
  private stream?: MediaStream;
  private input?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private socket?: WebSocket;
  private playback?: PcmPlayback;
  private abort = new AbortController();
  private connectTimer?: ReturnType<typeof setTimeout>;
  private callTimer?: ReturnType<typeof setTimeout>;
  private trackEnded = () => this.fail('Microphone disconnected. Reconnect it, then tap Start call.');

  constructor(private callbacks: BrowserCallCallbacks) {}

  setMuted(muted: boolean): void {
    if (this.stopped) return;
    this.muted = muted;
    // Disabling the captured track produces silence, without releasing permission.
    // https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/enabled
    this.stream?.getTracks().forEach((track) => { if (track.kind === 'audio') track.enabled = !muted; });
    // Discard a partial packet so no pre-mute samples escape in the next frame.
    if (this.context) this.encode = createPcmEncoder(this.context.sampleRate);
  }

  async start(accessCode: string): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      if (!globalThis.isSecureContext) throw new Error('Microphone access requires HTTPS. Open the secure demo link in your browser.');
      if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot run the voice demo. Use a current Safari on iPhone or Chrome on Android, outside in-app browsers.');
      }
      this.connectTimer = setTimeout(() => this.fail('Connection timed out after 15 seconds. Check microphone permission and your connection, then try again.'), 15000);
      // Resume synchronously within the gesture, before permission/network awaits.
      // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume
      const context = new AudioContext({latencyHint: 'interactive'});
      this.context = context;
      await context.resume();
      if (this.stopped) return;
      if (context.state !== 'running') throw new Error('Audio could not start. On iPhone, open this page in Safari and tap Start call again.');
      if (!context.audioWorklet) throw new Error('AudioWorklet is unavailable. Open the HTTPS link in a current Safari or Chrome browser.');
      const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false});
      if (this.stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      for (const track of stream.getTracks()) {
        if (track.kind === 'audio') track.enabled = !this.muted;
        track.addEventListener('ended', this.trackEnded);
      }
      const response = await fetch('/api/demo/session', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({accessCode}),
        signal: this.abort.signal, cache: 'no-store', credentials: 'same-origin',
      });
      if (this.stopped) return;
      if (!response.ok) {
        const messages: Record<number, string> = {
          401: 'That access code is incorrect. Check the code and try again.',
          429: 'The voice demo is busy with another call. Please try again shortly.',
          503: 'The voice demo is offline. Please try again later.',
        };
        throw new Error(messages[response.status] ?? 'Could not create a demo session. Please try again.');
      }
      const session: unknown = await response.json();
      if (this.stopped) return;
      if (!session || typeof session !== 'object' || !('token' in session) || typeof session.token !== 'string' || !session.token || !('websocketUrl' in session) || typeof session.websocketUrl !== 'string') {
        throw new Error('The demo returned an invalid session. Please try again.');
      }
      const url = new URL(session.websocketUrl);
      if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('The demo audio connection requires a secure WebSocket URL.');
      }
      // Self-hosted module, served from public/audio; never a blob/eval worklet.
      // https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode
      await context.audioWorklet.addModule('/audio/pcm-capture.js');
      if (this.stopped) return;
      this.encode = createPcmEncoder(context.sampleRate);
      this.playback = new PcmPlayback(context, (error) => this.fail(microphoneError(error)));
      this.worklet = new AudioWorkletNode(context, 'pcm-capture', {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit'});
      this.input = context.createMediaStreamSource(stream);
      this.input.connect(this.worklet);
      this.worklet.connect(context.destination); // Processor output stays silent: no microphone monitoring.
      const socket = new WebSocket(url.href);
      this.socket = socket;
      // https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (!this.stopped) {
          try { socket.send(JSON.stringify({type: 'authenticate', token: session.token})); }
          catch { this.fail('Could not authenticate the voice connection. Please try again.'); }
        }
      };
      this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (this.stopped || !this.ready || socket.readyState !== WebSocket.OPEN) return;
        try {
          // Silence already-delivered worklet chunks too when mute was just set.
          const samples = this.muted ? new Float32Array(event.data.length) : event.data;
          // Monotonic throttle; no queued callbacks can outlive stop().
          // https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
          const now = performance.now();
          if (this.callbacks.onMicLevel && now - this.lastMicLevelAt >= 100) {
            let squares = 0;
            for (const sample of samples) squares += Number.isFinite(sample) ? sample * sample : 0;
            this.lastMicLevelAt = now;
            this.callbacks.onMicLevel(Math.min(1, Math.sqrt(squares / (samples.length || 1))));
          }
          if (this.stopped) return;
          for (const packet of this.encode!(samples)) {
            // WebSocket has no automatic backpressure; bound unsent bytes.
            // https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount
            if (socket.bufferedAmount + packet.byteLength > MAX_SEND_BYTES) throw new Error('Your network is too slow for live audio. Try a stronger connection and start again.');
            socket.send(packet);
          }
        } catch (error) { this.fail(microphoneError(error)); }
      };
      this.worklet.onprocessorerror = () => this.fail('Microphone audio processing stopped. Reload this page and try again.');
      socket.onmessage = (event: MessageEvent) => this.receive(event.data);
      socket.onerror = () => this.fail('Could not connect to the voice demo. Reload this page, re-enter your access code, then tap Start call. If the issue persists, use Chrome on Android or Safari on iPhone.');
      socket.onclose = () => this.fail('The voice connection closed. Tap Start call to reconnect.');
      context.onstatechange = () => {
        if (this.ready && context.state !== 'running') this.fail('Audio was interrupted. Keep this page open; on iPhone use Safari, then tap Start call again.');
      };
    } catch (error) {
      if (!this.stopped) this.fail(microphoneError(error));
    }
  }

  private receive(data: unknown): void {
    if (this.stopped) return;
    try {
      if (data instanceof ArrayBuffer) {
        if (this.ready) this.playback?.enqueue(data);
        return;
      }
      if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid voice demo message. Please reconnect.');
      const message = JSON.parse(data);
      if (message?.type === 'ready' && !this.ready) {
        if (this.context?.state !== 'running') throw new Error('Audio was interrupted while connecting. On iPhone, open this page in Safari and tap Start call again.');
        this.ready = true;
        clearTimeout(this.connectTimer);
        this.callTimer = setTimeout(() => {
          this.stop();
          this.callbacks.onEnded('The 10-minute practice call has ended. You can start another call.');
        }, 600000);
        this.callbacks.onReady();
      } else if (message?.type === 'clear') {
        this.playback?.clear();
      } else if (message?.type === 'error') {
        this.fail(typeof message.message === 'string' && message.message ? message.message.slice(0, 300) : 'The voice demo encountered an error. Please try again.');
      } else if (message?.type !== 'ready') {
        throw new Error('Invalid voice demo message. Please reconnect.');
      }
    } catch (error) { this.fail(error instanceof SyntaxError ? 'Invalid voice demo response. Please reconnect.' : microphoneError(error)); }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stop();
    this.callbacks.onError(message);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.connectTimer);
    clearTimeout(this.callTimer);
    this.abort.abort();
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
      this.socket.close();
    }
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.onprocessorerror = null;
      this.worklet.port.close();
      this.worklet.disconnect();
    }
    this.input?.disconnect();
    this.playback?.clear();
    this.stream?.getTracks().forEach((track) => { track.removeEventListener('ended', this.trackEnded); track.stop(); });
    if (this.context) {
      this.context.onstatechange = null;
      if (this.context.state !== 'closed') void this.context.close().catch(() => {});
    }
  }
}
