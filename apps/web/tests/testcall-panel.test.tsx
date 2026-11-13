// @vitest-environment jsdom
import React from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {AgentVersion} from '@/lib/data';

const draft: AgentVersion = {
  id: 'agent-version-4', agentId: 'agent-1', versionNo: 4, status: 'draft',
  promptSections: {persona: 'Maya is concise.', rules: 'Confirm every request.'},
  voices: {}, rules: {}, publishedAt: null, publishedBy: null,
  createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z'
};
const strings = {
  testMode: 'Test mode: nothing is booked or texted', start: 'Start test call', stop: 'End test call',
  micLevel: 'Microphone input level', interrupt: 'Interrupt with feedback', transcript: 'Live transcript',
  waiting: 'Not connected', connected: 'Connected', emptyTranscript: 'Start a call to see the transcript.',
  feedback: 'Feedback', feedbackPlaceholder: 'Say it shorter', propose: 'Propose change', before: 'Before',
  after: 'After', accept: 'Accept', reject: 'Reject', caller: 'Caller', agent: 'Agent',
  transportLive: 'Worker WebRTC', transportSimulated: 'Simulated - needs worker',
  micErrors: {permissionDenied: 'Permission denied', noDevice: 'No microphone', insecureContext: 'Secure context required', unavailable: 'Microphone unavailable'},
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('test-call panel', () => {
  it('renders on the server without reading browser globals', async () => {
    const {TestCallPanel} = await import('@/components/test-call-panel');
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);

    try {
      expect(() => renderToStaticMarkup(<TestCallPanel
        draft={draft} personaName="Maya" primaryLanguage="en" workerBaseUrl=""
        strings={strings} onAccept={vi.fn()}
      />)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs the simulated call, shows dir=auto transcript, and accepts or rejects a diff', async () => {
    const {TestCallPanel} = await import('@/components/test-call-panel');
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const trackStop = vi.fn();
    render(<TestCallPanel
      draft={draft} personaName="Maya" primaryLanguage="en" workerBaseUrl=""
      strings={strings} onAccept={onAccept}
      microphoneEnvironment={{isSecureContext: true, mediaDevices: {getUserMedia: vi.fn().mockResolvedValue({getTracks: () => [{stop: trackStop}]})}}}
      startMeter={() => () => {}}
    />);

    expect(screen.getByText('Test mode: nothing is booked or texted')).toBeTruthy();
    expect(screen.getByText('Simulated - needs worker')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Start test call'}));
    expect(await screen.findByText('Connected', {exact: true})).toBeTruthy();
    expect((await screen.findByText('Can I book a table for four tonight?')).getAttribute('dir')).toBe('auto');
    expect(screen.getAllByText('en').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', {name: 'Interrupt with feedback'}));
    fireEvent.change(screen.getByPlaceholderText('Say it shorter'), {target: {value: 'Say it shorter.'}});
    fireEvent.click(screen.getByRole('button', {name: 'Propose change'}));
    const proposedText = (_: string, element: Element | null) => element?.tagName === 'PRE' && element.textContent === 'Confirm every request.\nSay it shorter.';
    expect(await screen.findByText(proposedText)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Reject'}));
    expect(screen.queryByText(proposedText)).toBeNull();

    fireEvent.click(screen.getByRole('button', {name: 'Interrupt with feedback'}));
    fireEvent.change(screen.getByPlaceholderText('Say it shorter'), {target: {value: 'Say it shorter.'}});
    fireEvent.click(screen.getByRole('button', {name: 'Propose change'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Accept'}));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith({
      section: 'rules', before: 'Confirm every request.', after: 'Confirm every request.\nSay it shorter.'
    }));
  });
});

class BrowserPeer extends EventTarget {
  static latest: BrowserPeer;
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription = {sdp: 'offer-sdp', type: 'offer' as const};
  constructor() { super(); BrowserPeer.latest = this; }
  addTrack = vi.fn();
  createOffer = vi.fn(async () => this.localDescription);
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  close = vi.fn();
  connect(state: RTCPeerConnectionState = 'connected') {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}
class BrowserStream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() { return this.tracks; }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
}

async function livePanel(getUserMedia?: () => Promise<MediaStream>) {
  const {TestCallPanel} = await import('@/components/test-call-panel');
  const stopTrack = vi.fn();
  const stream = new BrowserStream([{kind: 'audio', stop: stopTrack} as unknown as MediaStreamTrack]) as unknown as MediaStream;
  const microphone = vi.fn(getUserMedia ?? (async () => stream));
  const stopMeter = vi.fn();
  const meter = vi.fn(() => stopMeter);
  const view = render(<TestCallPanel
    draft={draft} personaName="Maya" primaryLanguage="en" workerBaseUrl="https://worker.example/"
    strings={strings} onAccept={vi.fn()}
    microphoneEnvironment={{isSecureContext: true, mediaDevices: {getUserMedia: microphone}}}
    startMeter={meter}
  />);
  return {...view, microphone, stream, stopTrack, meter, stopMeter};
}

describe('live test-call panel lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', BrowserPeer);
    vi.stubGlobal('MediaStream', BrowserStream);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({sdp: 'answer', type: 'answer', pc_id: 'pc-1'}))));
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  it('allows hang-up while connecting and stops permission granted after hang-up', async () => {
    let grant!: (stream: MediaStream) => void;
    const view = await livePanel(() => new Promise((resolve) => { grant = resolve; }));
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    expect(screen.queryByText(strings.connected, {exact: true})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: strings.stop}));
    await act(async () => { grant(view.stream); });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
    expect(view.microphone).toHaveBeenCalledOnce();
    expect(view.stopTrack).toHaveBeenCalledOnce();
    expect(view.meter).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name: strings.start})).toBeTruthy();
  });

  it('releases a microphone permission result arriving after unmount', async () => {
    let grant!: (stream: MediaStream) => void;
    const view = await livePanel(() => new Promise((resolve) => { grant = resolve; }));
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    view.unmount();
    await act(async () => { grant(view.stream); });
    expect(view.stopTrack).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
    expect(view.meter).not.toHaveBeenCalled();
  });

  it.each(['hang-up', 'unmount'] as const)('cancels ICE on %s and prevents late connection', async (action) => {
    class GatheringPeer extends BrowserPeer { iceGatheringState: RTCIceGatheringState = 'gathering'; }
    vi.stubGlobal('RTCPeerConnection', GatheringPeer);
    const view = await livePanel();
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    await waitFor(() => expect(BrowserPeer.latest?.setLocalDescription).toHaveBeenCalled());
    const peer = BrowserPeer.latest;
    if (action === 'unmount') view.unmount();
    else fireEvent.click(screen.getByRole('button', {name: strings.stop}));
    await act(async () => {
      peer.iceGatheringState = 'complete';
      peer.dispatchEvent(new Event('icegatheringstatechange'));
      peer.connect();
    });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(view.stopTrack).toHaveBeenCalled();
    expect(view.stopMeter).toHaveBeenCalledOnce();
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(screen.queryByText(strings.connected, {exact: true})).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('releases connected remote audio and all call resources on unmount', async () => {
    const view = await livePanel();
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    await waitFor(() => expect(BrowserPeer.latest?.setRemoteDescription).toHaveBeenCalled());
    const peer = BrowserPeer.latest;
    const remoteStop = vi.fn();
    await act(async () => {
      peer.dispatchEvent(Object.assign(new Event('track'), {track: {kind: 'audio', stop: remoteStop}, streams: []}));
      peer.connect();
    });
    const audio = view.container.querySelector('audio')!;
    expect(audio.srcObject).toBeTruthy();
    view.unmount();
    expect(audio.srcObject).toBeNull();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(remoteStop).toHaveBeenCalledOnce();
    expect(view.stopTrack).toHaveBeenCalled();
    expect(view.stopMeter).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('ignores old playback %s after hang-up and restart', async (settlement) => {
    const view = await livePanel();
    let resolveOld!: () => void;
    let rejectOld!: (error: DOMException) => void;
    vi.mocked(HTMLMediaElement.prototype.play)
      .mockResolvedValueOnce(undefined) // Initial user gesture.
      .mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    await waitFor(() => expect(BrowserPeer.latest?.setRemoteDescription).toHaveBeenCalled());
    const oldPeer = BrowserPeer.latest;
    await act(async () => {
      oldPeer.dispatchEvent(Object.assign(new Event('track'), {track: {kind: 'audio', stop: vi.fn()}, streams: []}));
      oldPeer.connect();
    });
    fireEvent.click(screen.getByRole('button', {name: strings.stop}));
    view.microphone.mockResolvedValueOnce(new BrowserStream([{kind: 'audio', stop: vi.fn()} as unknown as MediaStreamTrack]) as unknown as MediaStream);
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    await waitFor(() => {
      expect(BrowserPeer.latest).not.toBe(oldPeer);
      expect(BrowserPeer.latest.setRemoteDescription).toHaveBeenCalled();
    });
    const newPeer = BrowserPeer.latest;
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'));
    await act(async () => {
      newPeer.dispatchEvent(Object.assign(new Event('track'), {track: {kind: 'audio', stop: vi.fn()}, streams: []}));
      newPeer.connect();
    });
    expect(view.container.querySelector('audio')!.controls).toBe(true);
    expect(view.container.querySelector('audio')!.hidden).toBe(false);
    await act(async () => {
      if (settlement === 'resolve') resolveOld();
      else rejectOld(new DOMException('Old playback aborted', 'AbortError'));
    });
    expect(view.container.querySelector('audio')!.controls).toBe(true);
    expect(view.container.querySelector('audio')!.hidden).toBe(false);
    fireEvent.playing(view.container.querySelector('audio')!);
    expect(view.container.querySelector('audio')!.controls).toBe(true);
    expect(screen.getByText(strings.connected, {exact: true})).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(newPeer.close).not.toHaveBeenCalled();
  });

  it('waits for peer connectivity, offers native playback controls, and cleans up on failure', async () => {
    const view = await livePanel();
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockRejectedValue(new DOMException('Tap required', 'NotAllowedError'));
    fireEvent.click(screen.getByRole('button', {name: strings.start}));
    // Attempt playback inside the initial click, before getUserMedia resolves.
    expect(play).toHaveBeenCalledOnce();
    await waitFor(() => expect(BrowserPeer.latest?.setRemoteDescription).toHaveBeenCalled());
    const peer = BrowserPeer.latest;
    expect(screen.queryByText(strings.connected, {exact: true})).toBeNull();
    const remoteStop = vi.fn();
    await act(async () => {
      peer.dispatchEvent(Object.assign(new Event('track'), {track: {kind: 'audio', stop: remoteStop}, streams: []}));
      peer.connect();
    });
    expect(await screen.findByText(strings.connected, {exact: true})).toBeTruthy();
    const audio = view.container.querySelector('audio')!;
    expect(audio.autoplay).toBe(true);
    expect(audio.hasAttribute('playsinline')).toBe(true);
    expect(audio.srcObject).toBeTruthy();
    play.mockResolvedValue(undefined);
    expect(audio.controls).toBe(true);
    expect(audio.hidden).toBe(false);
    // The native play control owns the user gesture; signal actual playback.
    vi.spyOn(audio, 'paused', 'get').mockReturnValue(false);
    await act(async () => { await audio.play(); fireEvent.playing(audio); });
    expect(audio.controls).toBe(false);
    expect(audio.hidden).toBe(true);
    await act(async () => peer.connect('failed'));
    expect(screen.queryByText(strings.connected, {exact: true})).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/connection failed/i);
    expect(audio.srcObject).toBeNull();
    expect(view.stopTrack).toHaveBeenCalled();
    expect(remoteStop).toHaveBeenCalledOnce();
    expect(view.stopMeter).toHaveBeenCalledOnce();
  });
});
