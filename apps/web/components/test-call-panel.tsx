'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {CircleStop, Mic, Phone, PhoneOff} from 'lucide-react';
import type {AgentVersion, Language} from '@/lib/data';
import {stripBidiControls} from '@/lib/security/text';
import {
  requestTestCallMicrophone,
  startMicLevelMeter,
  TestCallMicrophoneError,
  type MicrophoneEnvironment,
} from '@/lib/testcall/microphone';
import {
  createMockTestCallTransport,
  createWebRtcTestCallTransport,
  type PromptChangeProposal,
  type TestCallTranscriptLine,
  type TestCallTransport,
} from '@/lib/testcall/transport';
import {Badge, Card, TranscriptBubble} from './ui';

interface TestCallStrings {
  testMode: string;
  start: string;
  stop: string;
  micLevel: string;
  interrupt: string;
  transcript: string;
  waiting: string;
  connected: string;
  emptyTranscript: string;
  feedback: string;
  feedbackPlaceholder: string;
  propose: string;
  before: string;
  after: string;
  accept: string;
  reject: string;
  caller: string;
  agent: string;
  transportLive: string;
  transportSimulated: string;
  micErrors: {
    permissionDenied: string;
    noDevice: string;
    insecureContext: string;
    unavailable: string;
  };
}

interface TestCallPanelProps {
  draft: AgentVersion;
  personaName: string;
  primaryLanguage: Language;
  workerBaseUrl: string;
  strings: TestCallStrings;
  onAccept(proposal: PromptChangeProposal): Promise<void>;
  microphoneEnvironment?: MicrophoneEnvironment;
  startMeter?: typeof startMicLevelMeter;
}

export function TestCallPanel({
  draft,
  personaName,
  primaryLanguage,
  workerBaseUrl,
  strings,
  onAccept,
  microphoneEnvironment,
  startMeter = startMicLevelMeter,
}: TestCallPanelProps) {
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [level, setLevel] = useState(0);
  const [lines, setLines] = useState<TestCallTranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [proposal, setProposal] = useState<PromptChangeProposal | null>(null);
  const [accepting, setAccepting] = useState(false);
  const transport = useRef<TestCallTransport | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const primedAudio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const inCall = useRef(false);
  const mounted = useRef(true);
  const endCall = useCallback(() => {
    generation.current += 1;
    inCall.current = false;
    if (transport.current) transport.current.stop();
    else if (primedAudio.current) {
      primedAudio.current.pause();
      primedAudio.current.srcObject = null;
    }
    primedAudio.current = null;
    transport.current = null;
    stopMeter.current?.();
    stopMeter.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (mounted.current) {
      setActive(false);
      setConnecting(false);
      setPlaybackBlocked(false);
      setLevel(0);
      setFeedbackOpen(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; endCall(); };
  }, [endCall]);

  const callError = (caught: unknown): string => {
    if (caught instanceof TestCallMicrophoneError) {
      const code = caught.code;
      return strings.micErrors[code === 'permission-denied' ? 'permissionDenied' : code === 'no-device' ? 'noDevice' : code === 'insecure-context' ? 'insecureContext' : 'unavailable'];
    }
    const messages: Record<string, string> = {
      WEBRTC_ICE_TIMEOUT: 'Call connection timed out while gathering network candidates. Try again.',
      WEBRTC_CONNECTION_TIMEOUT: 'Call connection timed out. Check your network and try again.',
      WEBRTC_CONNECTION_FAILED: 'Call connection failed. Try again.',
      WEBRTC_CONNECTION_CLOSED: 'Call connection closed. Start a new call.',
      WEBRTC_CONNECTION_DISCONNECTED: 'Call connection lost. Check your network and try again.',
      WEBRTC_OFFER_REJECTED: 'The voice worker could not accept the call. Try again.',
      WEBRTC_ANSWER_INVALID: 'The voice worker returned an invalid connection answer. Try again.',
      WEBRTC_AUDIO_PLAYBACK_FAILED: 'Call audio could not play. Start a new call.',
    };
    return caught instanceof Error && messages[caught.message]
      ? messages[caught.message]
      : workerBaseUrl ? 'Call connection failed. Try again.' : strings.micErrors.unavailable;
  };

  const startCall = async () => {
    // A ref closes the gap before React commits the connecting button state.
    if (inCall.current) return;
    inCall.current = true;
    const attempt = ++generation.current;
    setConnecting(true);
    setError(null);
    setLines([]);
    const failed = (caught: unknown) => {
      if (generation.current !== attempt || !mounted.current) return;
      endCall();
      setError(callError(caught));
    };
    try {
      // Keep this first play() inside the tap. Some browsers still require a
      // second tap once media arrives: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
      if (workerBaseUrl) {
        primedAudio.current = audio.current;
        void audio.current?.play().catch(() => {});
      }
      const environment = microphoneEnvironment ?? {
        isSecureContext: window.isSecureContext,
        mediaDevices: navigator.mediaDevices,
      };
      const microphone = await requestTestCallMicrophone(environment);
      if (generation.current !== attempt || !mounted.current) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = microphone;
      stopMeter.current = startMeter(microphone, setLevel);
      const selected = workerBaseUrl
        ? createWebRtcTestCallTransport({workerBaseUrl, draft, audioElement: audio.current!})
        : createMockTestCallTransport(draft, personaName, primaryLanguage);
      transport.current = selected;
      await selected.start(microphone, {
        onTranscript: (line) => {
          if (generation.current === attempt) setLines((current) => [...current, line]);
        },
        onError: failed,
        onPlaybackBlocked: (blocked) => {
          if (generation.current === attempt) setPlaybackBlocked(blocked);
        },
      });
      if (generation.current !== attempt || !mounted.current) return;
      setConnecting(false);
      setActive(true);
    } catch (caught) {
      failed(caught);
    }
  };


  const propose = async () => {
    if (!transport.current || !feedback.trim()) return;
    setProposal(await transport.current.interrupt(feedback));
    setFeedbackOpen(false);
  };

  const accept = async () => {
    if (!proposal) return;
    setAccepting(true);
    try { await onAccept(proposal); } finally { setAccepting(false); }
  };

  const transportLabel = workerBaseUrl ? strings.transportLive : strings.transportSimulated;
  const ongoing = active || connecting;
  const meterBars = [0.45, 0.7, 1, 0.7, 0.45];
  return <div className="space-y-4">
    <audio ref={audio} autoPlay playsInline controls={playbackBlocked} hidden={!playbackBlocked}
      onPlaying={(event) => { if (inCall.current && !event.currentTarget.paused) setPlaybackBlocked(false); }}/>
    <div role="status" className="rounded-lg border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] p-3 font-semibold text-[var(--warning)]">{strings.testMode}</div>
    <Card className="overflow-hidden p-0">
      <div className="grid min-h-[460px] min-w-0 lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
        <section className="grid min-w-0 place-items-center border-b p-6 text-center lg:border-b-0 lg:border-r">
          <div className="w-full max-w-xs">
            <Badge tone={workerBaseUrl ? 'success' : 'warning'}>{transportLabel}</Badge>
            <button onClick={ongoing ? endCall : startCall} aria-label={ongoing ? strings.stop : strings.start} className={`mx-auto mt-8 grid size-28 place-items-center rounded-full text-white shadow-lg transition-transform hover:scale-105 ${ongoing ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'}`}>
              {ongoing ? <PhoneOff aria-hidden="true" size={38}/> : <Phone aria-hidden="true" size={38}/>}
            </button>
            <p className="mt-4 font-semibold">{ongoing ? strings.stop : strings.start}</p>
            <div aria-label={strings.micLevel} className="mx-auto mt-6 flex h-12 items-end justify-center gap-1" role="meter" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100}>
              {meterBars.map((factor, index) => <span key={index} className="w-2 rounded-full bg-[var(--accent)] transition-[height]" style={{height: Math.max(6, 48 * factor * (level / 100))}}/>)}
            </div>
            {error && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--danger)]">{error}</p>}
            <button disabled={!active} onClick={() => setFeedbackOpen(true)} className="mt-6 min-h-11 rounded-lg border px-4 font-semibold disabled:text-[var(--muted)]"><CircleStop aria-hidden="true" className="mr-2 inline" size={17}/>{strings.interrupt}</button>
          </div>
        </section>
        <section className="flex min-h-80 min-w-0 flex-col p-5">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{strings.transcript}</h2><Badge tone={active ? 'success' : 'neutral'}>{active ? strings.connected : strings.waiting}</Badge></div>
          <div className="mt-4 flex flex-1 flex-col gap-3" aria-live="polite">
            {lines.length ? lines.map((line) => <TranscriptBubble key={line.id} speaker={line.speaker} meta={<span className="flex items-center gap-2"><span>{line.speaker === 'agent' ? strings.agent : strings.caller}</span><Badge>{line.language}</Badge></span>}><p dir="auto">{stripBidiControls(line.text)}</p></TranscriptBubble>) : <div className="grid flex-1 place-items-center text-center"><div><Mic aria-hidden="true" className="mx-auto text-[var(--muted)]" size={28}/><p className="mt-3 text-[var(--muted)]">{strings.emptyTranscript}</p></div></div>}
          </div>
          {feedbackOpen && <div className="mt-4 rounded-lg border p-4"><label className="text-sm font-semibold">{strings.feedback}<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={strings.feedbackPlaceholder} rows={3} className="mt-2 w-full rounded-lg border bg-[var(--background)] p-3 font-normal"/></label><button onClick={propose} disabled={!feedback.trim()} className="mt-3 min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:opacity-50">{strings.propose}</button></div>}
          {proposal && <div className="mt-4 rounded-lg border border-[var(--accent)] p-4"><strong>{proposal.section}</strong><div className="mt-3 grid gap-3 md:grid-cols-2"><Diff label={strings.before} value={proposal.before}/><Diff label={strings.after} value={proposal.after}/></div><div className="mt-3 flex gap-2"><button disabled={accepting} onClick={accept} className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{strings.accept}</button><button onClick={() => setProposal(null)} className="min-h-11 rounded-lg border px-4 font-semibold">{strings.reject}</button></div></div>}
        </section>
      </div>
    </Card>
  </div>;
}

function Diff({label, value}: {label: string; value: string}) {
  return <div className="min-w-0"><span className="text-xs font-bold uppercase text-[var(--muted)]">{label}</span><pre dir="auto" className="mt-1 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-[var(--background)] p-3 font-sans text-sm">{stripBidiControls(value)}</pre></div>;
}
