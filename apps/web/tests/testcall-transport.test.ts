// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createWebRtcTestCallTransport} from '@/lib/testcall/transport';
import type {AgentVersion} from '@/lib/data';

const draft: AgentVersion = {
  id: 'agent-version-4', agentId: 'agent-1', versionNo: 4, status: 'draft',
  promptSections: {persona: 'Maya is concise.', rules: 'Confirm every request.'},
  voices: {}, rules: {}, publishedAt: null, publishedBy: null,
  createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z'
};

describe('test-call transports', () => {
  it('runs a simulated role-play from the current draft and proposes a section diff', async () => {
    const {createMockTestCallTransport} = await import('@/lib/testcall/transport');
    const transcript: unknown[] = [];
    const transport = createMockTestCallTransport(draft, 'Maya', 'en');

    await transport.start({} as MediaStream, {onTranscript: (line) => transcript.push(line)});
    const proposal = await transport.interrupt('Say it shorter.');

    expect(transport.label).toBe('Simulated - needs worker');
    expect(transcript).toEqual([
      {id: 'sim-1', speaker: 'agent', language: 'en', text: 'Maya: Maya is concise.'},
      {id: 'sim-2', speaker: 'caller', language: 'en', text: 'Can I book a table for four tonight?'},
      {id: 'sim-3', speaker: 'agent', language: 'en', text: 'I can help with that. This simulated call will not create a booking.'},
    ]);
    expect(proposal).toEqual({
      section: 'rules',
      before: 'Confirm every request.',
      after: 'Confirm every request.\nSay it shorter.',
    });
  });


});

class Peer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription = {sdp: 'offer-sdp', type: 'offer' as const};
  addTrack = vi.fn();
  createOffer = vi.fn(async () => this.localDescription);
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  close = vi.fn(() => { this.connectionState = 'closed'; });
  connect(state: RTCPeerConnectionState = 'connected') {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  receive(track: MediaStreamTrack, streams: MediaStream[] = []) {
    this.dispatchEvent(Object.assign(new Event('track'), {track, streams}));
  }
}

class Stream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() { return this.tracks; }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
}

function setup() {
  const peer = new Peer();
  const audioElement = document.createElement('audio');
  const localTrack = {kind: 'audio', stop: vi.fn()} as unknown as MediaStreamTrack;
  const remoteTrack = {kind: 'audio', stop: vi.fn()} as unknown as MediaStreamTrack;
  const stream = new Stream([localTrack]) as unknown as MediaStream;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({sdp: 'answer-sdp', type: 'answer', pc_id: 'pc-1'})));
  const handlers = {onTranscript: vi.fn(), onError: vi.fn(), onPlaybackBlocked: vi.fn()};
  const transport = createWebRtcTestCallTransport({workerBaseUrl: 'https://worker.example/', fetcher, createPeerConnection: () => peer, audioElement});
  return {peer, audioElement, localTrack, remoteTrack, stream, fetcher, handlers, transport};
}

describe('WebRTC lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaStream', Stream);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('plays remote audio inline, including streamless tracks, and releases it on stop', async () => {
    const {peer, audioElement, remoteTrack, localTrack, stream, handlers, transport} = setup();
    const started = transport.start(stream, handlers);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    peer.receive(remoteTrack);
    peer.connect();
    await started;

    expect((audioElement.srcObject as MediaStream)?.getTracks()).toContain(remoteTrack);
    expect(audioElement.autoplay).toBe(true);
    expect(audioElement.hasAttribute('playsinline')).toBe(true);
    expect(audioElement.play).toHaveBeenCalled();
    transport.stop();
    transport.stop();
    expect(audioElement.pause).toHaveBeenCalledOnce();
    expect(audioElement.srcObject).toBeNull();
    expect(remoteTrack.stop).toHaveBeenCalledOnce();
    expect(localTrack.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('posts the SmallWebRTC offer but does not resolve start on SDP acceptance', async () => {
    const {peer, stream, handlers, transport, fetcher} = setup();
    let connected = false;
    const started = transport.start(stream, handlers).then(() => { connected = true; });
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledWith({sdp: 'answer-sdp', type: 'answer'}));
    expect(fetcher).toHaveBeenCalledWith('/api/test-call/offer', expect.objectContaining({
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sdp: 'offer-sdp', type: 'offer'}),
    }));
    expect(connected).toBe(false);
    peer.connect();
    await started;
    expect(connected).toBe(true);
    transport.stop();
  });

  it('bounds ICE gathering and removes listeners and tracks on timeout', async () => {
    const {peer, stream, handlers, transport, fetcher, localTrack} = setup();
    peer.iceGatheringState = 'gathering';
    const outcome = transport.start(stream, handlers).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.race([outcome, Promise.resolve('STILL_PENDING')])).toBe('WEBRTC_ICE_TIMEOUT');
    expect(localTrack.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    peer.iceGatheringState = 'complete';
    peer.dispatchEvent(new Event('icegatheringstatechange'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ice', 'offer', 'connection'] as const)('cancels a pending %s wait on stop without later negotiation', async (stage) => {
    const {peer, stream, handlers, transport, fetcher, localTrack} = setup();
    if (stage === 'ice') peer.iceGatheringState = 'gathering';
    let answer!: (value: Response) => void;
    if (stage === 'offer') fetcher.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const outcome = transport.start(stream, handlers).then(() => 'CONNECTED', (error: Error) => error.message);
    if (stage === 'ice') await vi.waitFor(() => expect(peer.setLocalDescription).toHaveBeenCalled());
    else if (stage === 'offer') await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    else await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    transport.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([outcome, Promise.resolve('STILL_PENDING')])).toBe('WEBRTC_STOPPED');
    if (stage === 'offer') {
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      answer(new Response(JSON.stringify({sdp: 'late', type: 'answer', pc_id: 'late'})));
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    }
    expect(localTrack.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled connection after accepting the answer', async () => {
    const {peer, stream, handlers, transport} = setup();
    const outcome = transport.start(stream, handlers).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.race([outcome, Promise.resolve('STILL_PENDING')])).toBe('WEBRTC_CONNECTION_TIMEOUT');
    expect(peer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prevents duplicate starts while negotiating and after stop', async () => {
    const {peer, stream, handlers, transport} = setup();
    const outcome = transport.start(stream, handlers).catch((error: Error) => error.message);
    await expect(transport.start(stream, handlers)).rejects.toThrow('WEBRTC_ALREADY_STARTED');
    transport.stop();
    await outcome;
    await expect(transport.start(stream, handlers)).rejects.toThrow('WEBRTC_STOPPED');
    expect(peer.addTrack).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'closed', 'disconnected'] as const)('cleans up and reports a %s connection after startup', async (state) => {
    const {peer, audioElement, stream, handlers, transport, remoteTrack} = setup();
    const started = transport.start(stream, handlers);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    peer.receive(remoteTrack, [new Stream([remoteTrack]) as unknown as MediaStream]);
    peer.connect();
    await started;
    peer.connect(state);
    expect(handlers.onError).toHaveBeenCalledWith(new Error(`WEBRTC_CONNECTION_${state.toUpperCase()}`));
    expect(audioElement.srcObject).toBeNull();
    expect(remoteTrack.stop).toHaveBeenCalledOnce();
    // Removed handlers must not reattach audio after hang-up.
    peer.receive({kind: 'audio', stop: vi.fn()} as unknown as MediaStreamTrack);
    expect(audioElement.srcObject).toBeNull();
  });

  it('ignores a superseded playback rejection when another audio track arrives', async () => {
    const {peer, audioElement, stream, handlers, transport, remoteTrack} = setup();
    let rejectFirst!: (error: DOMException) => void;
    vi.mocked(audioElement.play).mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }));
    const started = transport.start(stream, handlers);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    peer.receive(remoteTrack);
    peer.connect();
    await started;
    const second = {kind: 'audio', stop: vi.fn()} as unknown as MediaStreamTrack;
    peer.receive(second);
    rejectFirst(new DOMException('Playback replaced', 'AbortError'));
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect((audioElement.srcObject as MediaStream).getTracks()).toEqual([remoteTrack, second]);
    expect(peer.close).not.toHaveBeenCalled();
    transport.stop();
  });

  it.each(['fetch', 'body'] as const)('bounds a stalled signaling %s and releases resources', async (stage) => {
    const {peer, stream, handlers, transport, fetcher, localTrack} = setup();
    if (stage === 'fetch') fetcher.mockImplementation(() => new Promise(() => {}));
    else fetcher.mockResolvedValue({ok: true, json: () => new Promise(() => {})} as Response);
    const outcome = transport.start(stream, handlers).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.race([outcome, Promise.resolve('STILL_PENDING')])).toBe('WEBRTC_CONNECTION_TIMEOUT');
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(localTrack.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['failed', 'closed', 'disconnected'] as const)('rejects startup immediately on a %s peer', async (state) => {
    const {peer, stream, handlers, transport} = setup();
    const outcome = transport.start(stream, handlers).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    peer.connect(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([outcome, Promise.resolve('STILL_PENDING')])).toBe(`WEBRTC_CONNECTION_${state.toUpperCase()}`);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports blocked autoplay without rejecting the connection', async () => {
    const {peer, audioElement, stream, handlers, transport, remoteTrack} = setup();
    vi.mocked(audioElement.play).mockRejectedValue(new DOMException('Tap required', 'NotAllowedError'));
    const started = transport.start(stream, handlers);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    peer.receive(remoteTrack);
    peer.connect();
    await started;
    await vi.waitFor(() => expect(handlers.onPlaybackBlocked).toHaveBeenCalledWith(true));
    expect(handlers.onError).not.toHaveBeenCalled();
    transport.stop();
  });
});
