import type {AgentVersion, Language} from '@/lib/data';

export interface TestCallTranscriptLine {
  id: string;
  speaker: 'caller' | 'agent';
  language: Language;
  text: string;
}

export interface PromptChangeProposal {
  section: string;
  before: string;
  after: string;
}

export interface TestCallHandlers {
  onTranscript(line: TestCallTranscriptLine): void;
  onError?(error: Error): void;
  onPlaybackBlocked?(blocked: boolean): void;
}

export interface TestCallTransport {
  readonly label: string;
  start(stream: MediaStream, handlers: TestCallHandlers): Promise<void>;
  interrupt(feedback: string): Promise<PromptChangeProposal>;
  stop(): void;
}

function proposal(draft: AgentVersion, feedback: string): PromptChangeProposal {
  const section = draft.promptSections.rules !== undefined
    ? 'rules'
    : Object.keys(draft.promptSections).sort()[0] ?? 'persona';
  const before = draft.promptSections[section] ?? '';
  return {section, before, after: [before, feedback.trim()].filter(Boolean).join('\n')};
}

export function createMockTestCallTransport(
  draft: AgentVersion,
  personaName: string,
  language: Language,
): TestCallTransport {
  return {
    label: 'Simulated - needs worker',
    async start(_stream, handlers) {
      const persona = draft.promptSections.persona || 'Friendly restaurant host.';
      handlers.onTranscript({id: 'sim-1', speaker: 'agent', language, text: `${personaName}: ${persona}`});
      handlers.onTranscript({id: 'sim-2', speaker: 'caller', language, text: 'Can I book a table for four tonight?'});
      handlers.onTranscript({id: 'sim-3', speaker: 'agent', language, text: 'I can help with that. This simulated call will not create a booking.'});
    },
    async interrupt(feedback) { return proposal(draft, feedback); },
    stop() {},
  };
}

interface PeerConnectionLike {
  readonly iceGatheringState: RTCIceGatheringState;
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: RTCSessionDescriptionInit | null;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): unknown;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  close(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface WebRtcTransportOptions {
  workerBaseUrl: string;
  draft?: AgentVersion;
  fetcher?: typeof fetch;
  createPeerConnection?: () => PeerConnectionLike;
  audioElement?: HTMLAudioElement;
}

// Cancellation also settles startup when a browser API or signaling request stalls.
function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function waitForPeer(
  peer: PeerConnectionLike,
  event: 'icegatheringstatechange' | 'connectionstatechange',
  ready: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
): Promise<void> {
  // ICE completion is signaled separately from peer connectivity:
  // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/icegatheringstatechange_event
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      peer.removeEventListener(event, changed);
      signal.removeEventListener('abort', aborted);
    };
    const changed = () => { if (ready()) { clean(); resolve(); } };
    const aborted = () => { clean(); reject(signal.reason); };
    const timer = setTimeout(() => { clean(); reject(new Error(timeoutCode)); }, timeoutMs);
    peer.addEventListener(event, changed);
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
    else changed();
  });
}

export function createWebRtcTestCallTransport(options: WebRtcTransportOptions): TestCallTransport {
  const fetcher = options.fetcher ?? fetch;
  const peer = options.createPeerConnection?.() ?? new RTCPeerConnection();
  const controller = new AbortController();
  const audio = options.audioElement ?? document.createElement('audio');
  let started = false;
  let stopped = false;
  let handlers: TestCallHandlers | undefined;
  let localStream: MediaStream | undefined;
  let remoteStream: MediaStream | undefined;
  let playbackAttempt = 0;
  const remoteTracks = new Set<MediaStreamTrack>();

  const stop = (reason = new Error('WEBRTC_STOPPED')) => {
    if (stopped) return;
    stopped = true;
    controller.abort(reason);
    peer.removeEventListener('track', receiveTrack);
    peer.removeEventListener('connectionstatechange', connectionChanged);
    audio.pause();
    audio.srcObject = null;
    if (!options.audioElement) audio.remove();
    localStream?.getTracks().forEach((track) => track.stop());
    remoteTracks.forEach((track) => track.stop());
    remoteTracks.clear();
    remoteStream = undefined;
    peer.close();
  };
  const fail = (error: Error) => {
    if (stopped) return;
    stop(error);
    handlers?.onError?.(error);
  };
  const connectionChanged = () => {
    // SDP acceptance is not a connected media transport.
    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/connectionstatechange_event
    const state = peer.connectionState;
    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      fail(new Error(`WEBRTC_CONNECTION_${state.toUpperCase()}`));
    }
  };
  const receiveTrack = (received: Event) => {
    const event = received as RTCTrackEvent;
    if (stopped || remoteTracks.has(event.track)) return;
    remoteTracks.add(event.track);
    if (event.track.kind !== 'audio') return;
    // RTCTrackEvent.streams may be empty; collect audio tracks into our own stream.
    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/track_event
    remoteStream ??= new MediaStream();
    if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
    if (audio.srcObject !== remoteStream) audio.srcObject = remoteStream;
    const attempt = ++playbackAttempt;
    // play() rejection requires an explicit user gesture retry in the panel.
    // https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
    void audio.play().then(() => {
      if (!stopped && attempt === playbackAttempt) handlers?.onPlaybackBlocked?.(false);
    }, (error: unknown) => {
      if (stopped || attempt !== playbackAttempt) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') handlers?.onPlaybackBlocked?.(true);
      else fail(new Error('WEBRTC_AUDIO_PLAYBACK_FAILED'));
    });
  };

  return {
    label: 'Worker WebRTC',
    async start(stream, callbacks) {
      if (stopped) throw new Error('WEBRTC_STOPPED');
      if (started) throw new Error('WEBRTC_ALREADY_STARTED');
      started = true;
      handlers = callbacks;
      localStream = stream;
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      if (!options.audioElement) { audio.hidden = true; document.body.append(audio); }
      peer.addEventListener('track', receiveTrack);
      peer.addEventListener('connectionstatechange', connectionChanged);
      const {signal} = controller;
      // Bound the entire setup too, including stalled SDP/signaling promises.
      const deadline = setTimeout(() => controller.abort(new Error('WEBRTC_CONNECTION_TIMEOUT')), 20_000);
      try {
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
        const offer = await cancellable(peer.createOffer(), signal);
        signal.throwIfAborted();
        await cancellable(peer.setLocalDescription(offer), signal);
        await waitForPeer(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete', signal, 10_000, 'WEBRTC_ICE_TIMEOUT');
        signal.throwIfAborted();
        const local = peer.localDescription;
        if (!local?.sdp || !local.type) throw new Error('WEBRTC_OFFER_UNAVAILABLE');
        // Pipecat 1.14.0 SmallWebRTC request/answer contract:
        // https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/transports/smallwebrtc/request_handler.py
        const response = await cancellable(fetcher('/api/test-call/offer', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({sdp: local.sdp, type: local.type}),
          signal,
        }), signal);
        signal.throwIfAborted();
        if (!response.ok) throw new Error('WEBRTC_OFFER_REJECTED');
        const answer = await cancellable(response.json(), signal) as {sdp?: unknown; type?: unknown; pc_id?: unknown};
        signal.throwIfAborted();
        if (typeof answer.sdp !== 'string' || answer.type !== 'answer' || typeof answer.pc_id !== 'string') {
          throw new Error('WEBRTC_ANSWER_INVALID');
        }
        await cancellable(peer.setRemoteDescription({sdp: answer.sdp, type: answer.type}), signal);
        await waitForPeer(peer, 'connectionstatechange', () => peer.connectionState === 'connected', signal, 20_000, 'WEBRTC_CONNECTION_TIMEOUT');
        signal.throwIfAborted();
      } catch (error) {
        stop(error instanceof Error ? error : new Error('WEBRTC_CONNECTION_FAILED'));
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    },
    async interrupt(feedback) {
      if (!options.draft) throw new Error('TEST_CALL_DRAFT_UNAVAILABLE');
      return proposal(options.draft, feedback);
    },
    stop() { stop(); },
  };
}
