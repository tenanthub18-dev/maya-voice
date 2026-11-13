'use client';

import {useEffect, useRef, useState} from 'react';
import {LockKeyhole, Mic, MicOff, Phone, PhoneOff, X} from 'lucide-react';
import {Button, Input} from '@/components/ui';
import {BRAND, getProductName} from '@/lib/brand';
import {BrowserAudioCall} from '@/lib/testcall/browser-audio';

// Page-local EN/FR copy keeps this isolated demo within its file ownership.
// The server page supplies the app locale.
const copy = {
  en: {
    private: 'Private demo', eyebrow: 'Meet your receptionist', title: 'A table-side conversation.',
    intro: `Call ${BRAND.defaultPersonaName} in your browser. Ask about dinner, book a table, or try a takeaway order.`,
    practice: 'AI assistant. Call text and usage may be saved for review; audio is not stored. Practice orders and bookings are not saved.',
    browser: 'No phone number or SMS needed.', restaurant: 'Restaurant practice line', channel: 'Browser audio',
    receptionist: 'Your multilingual receptionist',
    code: 'Access code', codeHint: 'Use the private demo code you were given.',
    ready: 'Ready when you are', connecting: 'Connecting — allow microphone access when prompted.',
    listening: 'Connected · listening', stopped: 'Call stopped. You can try again.',
    ended: 'Call ended. You can start another practice call.', start: 'Start call', end: 'End call', cancel: 'Cancel connection',
    limitEnded: 'The 10-minute practice call has ended. You can start another call.',
    greeting: `Say hello to ${BRAND.defaultPersonaName}. Speak naturally, just as you would on the phone.`,
    beforeCall: 'Allow your microphone when asked. Your browser plays the reply.',
    limit: 'Up to 10 minutes per practice call.', elapsed: 'Elapsed call time',
    micLevel: 'Microphone activity', mic: 'Your microphone', muted: 'Microphone muted', mute: 'Mute microphone', unmute: 'Unmute microphone', muteLabel: 'Mute', unmuteLabel: 'Unmute',
    guidanceTitle: 'A few things to try',
    suggestions: ['Ask what’s on the menu.', 'Check the opening hours.', 'Book a table for two.', 'Order something to take away.'],
    languageTitle: 'Seven languages. One conversation.', languages: 'English, French, Hindi, Urdu, Punjabi, Telugu or Arabic.',
    switching: `Switch languages during the call — ask ${BRAND.defaultPersonaName} to continue in another language, or simply start speaking it.`,
  },
  fr: {
    private: 'Démo privée', eyebrow: 'Votre réceptionniste vous attend', title: 'Une conversation à table.',
    intro: `Appelez ${BRAND.defaultPersonaName} dans votre navigateur. Parlez du menu, réservez une table ou essayez une commande à emporter.`,
    practice: 'Vous parlez à un assistant IA. Le texte de l’appel et les données d’utilisation peuvent être conservés pour examen; l’audio n’est pas conservé. Les commandes et réservations de pratique ne sont pas enregistrées.',
    browser: 'Aucun numéro de téléphone ni SMS requis.', restaurant: 'Ligne de pratique du restaurant', channel: 'Audio du navigateur',
    receptionist: 'Votre réceptionniste multilingue',
    code: 'Code d’accès', codeHint: 'Utilisez le code privé de la démo qui vous a été fourni.',
    ready: 'Prête quand vous l’êtes', connecting: 'Connexion — autorisez l’accès au microphone lorsque demandé.',
    listening: 'En ligne · à l’écoute', stopped: 'Appel interrompu. Vous pouvez réessayer.',
    ended: 'Appel terminé. Vous pouvez commencer un autre appel de pratique.', start: 'Démarrer l’appel', end: 'Terminer l’appel', cancel: 'Annuler la connexion',
    limitEnded: 'L’appel de pratique de 10 minutes est terminé. Vous pouvez commencer un autre appel.',
    greeting: `Dites bonjour à ${BRAND.defaultPersonaName}. Parlez naturellement, comme au téléphone.`,
    beforeCall: 'Autorisez votre microphone lorsque demandé. La réponse joue dans le navigateur.',
    limit: 'Au plus 10 minutes par appel de pratique.', elapsed: 'Durée de l’appel',
    micLevel: 'Activité du microphone', mic: 'Votre microphone', muted: 'Microphone en sourdine', mute: 'Couper le microphone', unmute: 'Activer le microphone', muteLabel: 'Couper', unmuteLabel: 'Activer',
    guidanceTitle: 'Quelques idées à essayer',
    suggestions: ['Demandez ce qu’il y a au menu.', 'Vérifiez les heures d’ouverture.', 'Réservez une table pour deux.', 'Commandez un repas à emporter.'],
    languageTitle: 'Sept langues. Une conversation.', languages: 'Anglais, français, hindi, ourdou, pendjabi, télougou ou arabe.',
    switching: `Changez de langue pendant l’appel — demandez à ${BRAND.defaultPersonaName} de continuer dans une autre langue, ou commencez simplement à la parler.`,
  },
};

export function BrowserDemo({locale = 'en', restaurantName, restaurantAddress}: {locale?: string; restaurantName?: string; restaurantAddress?: string}) {
  const strings = locale.toLowerCase().startsWith('fr') ? copy.fr : copy.en;
  const [accessCode, setAccessCode] = useState('');
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'listening'>('idle');
  const [status, setStatus] = useState(strings.ready);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const call = useRef<BrowserAudioCall | null>(null);
  const connectedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const ongoing = phase !== 'idle';

  useEffect(() => () => {
    const current = call.current;
    call.current = null;
    current?.stop();
    if (timer.current !== null) clearInterval(timer.current);
    connectedAt.current = null;
  }, []);

  const finish = (message: string) => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    connectedAt.current = null;
    setPhase('idle');
    setMicLevel(0);
    setMuted(false);
    setStatus(message);
  };

  const end = () => {
    const current = call.current;
    call.current = null;
    current?.stop();
    finish(strings.ended);
  };

  const toggleMuted = () => {
    if (!call.current || phase !== 'listening') return;
    call.current.setMuted(!muted);
    setMuted(!muted);
    setMicLevel(0);
  };

  const start = () => {
    if (call.current || !accessCode.trim()) return;
    setError('');
    setElapsed(0);
    setMicLevel(0);
    setMuted(false);
    setPhase('connecting');
    setStatus(strings.connecting);
    const current = new BrowserAudioCall({
      onReady: () => {
        if (call.current !== current || connectedAt.current !== null) return;
        connectedAt.current = Date.now();
        timer.current = setInterval(() => {
          if (connectedAt.current !== null) setElapsed(Math.floor((Date.now() - connectedAt.current) / 1000));
        }, 1000);
        setPhase('listening');
        setStatus(strings.listening);
      },
      onMicLevel: (level) => {
        if (call.current === current && connectedAt.current !== null) setMicLevel(level);
      },
      onError: (message) => {
        if (call.current !== current) return;
        call.current = null;
        finish(strings.stopped);
        setError(message);
      },
      onEnded: () => {
        if (call.current !== current) return;
        call.current = null;
        finish(strings.limitEnded);
      },
    });
    call.current = current; // Synchronous lock, including before React re-renders.
    // Do not defer start: AudioContext.resume must run inside this user gesture.
    // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume
    void current.start(accessCode);
  };

  const level = phase === 'listening' && !muted ? Math.max(0, Math.min(1, micLevel)) : 0;
  const duration = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;

  return <main className="mx-auto w-full max-w-6xl px-5 pt-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-8 sm:pt-8 lg:px-12">
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b pb-5">
      <p className="font-display text-xl tracking-tight text-[var(--color-accent)]">{getProductName(locale)}</p>
      <p className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><LockKeyhole aria-hidden="true" size={13}/>{strings.private}</p>
    </header>

    <div className="grid items-start gap-x-16 gap-y-8 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1fr)] lg:gap-y-10 lg:pt-16">
      <section aria-labelledby="demo-title" className="max-w-md">
        <p className="mb-3 text-xs font-semibold tracking-[var(--tracking-label)] text-[var(--color-accent)] uppercase">{strings.eyebrow}</p>
        <h1 id="demo-title" className="max-w-[16ch] text-[clamp(2rem,4vw,2.75rem)] leading-[1.12] tracking-tight">{restaurantName || strings.title}</h1>
        {restaurantAddress && <p className="mt-4 max-w-sm text-sm text-[var(--color-text-muted)]">{restaurantAddress}</p>}
        <p className="mt-4 max-w-sm text-[var(--color-text-muted)]">{strings.intro}</p>
      </section>

      <section aria-labelledby="demo-receptionist" className="min-w-0 overflow-hidden rounded-[var(--radius-panel)] border bg-[var(--color-surface)] lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4 text-xs text-[var(--color-text-muted)] sm:px-8">
          <p className="max-w-[26ch]">{restaurantName || strings.restaurant}</p><p>{strings.channel}</p>
        </div>
        <div className="px-5 pt-7 sm:px-8 sm:pt-8">
          <div className="flex items-center gap-4">
            <div aria-hidden="true" className="font-display grid size-16 shrink-0 place-items-center rounded-[var(--radius-panel)] bg-[var(--color-accent-soft)] text-3xl text-[var(--color-accent)] sm:size-18">{BRAND.defaultPersonaName.slice(0, 1)}</div>
            <div className="min-w-0">
              <h2 id="demo-receptionist" className="font-display break-words text-2xl tracking-tight">{BRAND.defaultPersonaName}</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">{strings.receptionist}</p>
            </div>
          </div>
          <div className="mt-7 flex items-start justify-between gap-4 border-t pt-5">
            <p role="status" aria-live="polite" aria-atomic="true" className="flex min-h-6 items-start gap-2 text-sm font-medium">
              <span aria-hidden="true" className={`mt-2 size-1.5 shrink-0 rounded-full ${phase === 'listening' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-border-strong)]'}`}/>{status}
            </p>
            {phase === 'listening' && <time role="timer" aria-label={strings.elapsed} aria-live="off" dateTime={`PT${elapsed}S`} className="shrink-0 text-sm tabular-nums text-[var(--color-text-muted)]">{duration}</time>}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
            <p className="flex items-center gap-2">{muted ? <MicOff aria-hidden="true" size={14}/> : <Mic aria-hidden="true" size={14}/>}{muted ? strings.muted : strings.mic}</p>
            <div role="meter" aria-label={strings.micLevel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
              <div aria-hidden="true" className="h-full origin-left bg-[var(--color-accent)] transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none" style={{transform: `scaleX(${level})`}}/>
            </div>
          </div>
          <p className="mt-5 min-h-10 text-sm text-[var(--color-text-muted)]">{phase === 'listening' ? strings.greeting : strings.beforeCall}</p>

          <form className="mt-6 pb-6 sm:pb-8" onSubmit={(event) => { event.preventDefault(); start(); }}>
            <div hidden={phase === 'listening'}>
              <Input id="demo-access-code" name="accessCode" label={strings.code} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={ongoing} value={accessCode} onChange={(event) => setAccessCode(event.target.value)} hint={strings.codeHint}/>
            </div>
            {phase === 'listening'
              ? <div className="grid grid-cols-2 gap-3">
                <Button type="button" variant="secondary" className="min-h-14 px-3 motion-reduce:transition-none" aria-label={muted ? strings.unmute : strings.mute} aria-pressed={muted} onClick={toggleMuted}>{muted ? <MicOff aria-hidden="true" size={18}/> : <Mic aria-hidden="true" size={18}/>}<span>{muted ? strings.unmuteLabel : strings.muteLabel}</span></Button>
                <Button type="button" variant="secondary" className="min-h-14 px-3 motion-reduce:transition-none" style={{color: 'var(--color-danger)'}} onClick={end}><PhoneOff aria-hidden="true" size={18}/>{strings.end}</Button>
              </div>
              : phase === 'connecting'
                ? <Button type="button" variant="secondary" className="mt-4 min-h-14 w-full motion-reduce:transition-none" onClick={end}><X aria-hidden="true" size={18}/>{strings.cancel}</Button>
                : <Button type="submit" className="mt-4 min-h-14 w-full motion-reduce:transition-none" disabled={!accessCode.trim()}><Phone aria-hidden="true" size={18}/>{strings.start}</Button>}
            {error && <p role="alert" className="mt-4 text-sm text-[var(--color-danger)]">{error}</p>}
            <p className="mt-4 text-center text-xs text-[var(--color-text-muted)]">{strings.limit}</p>
          </form>
        </div>
        <div className="border-t bg-[var(--color-canvas)] px-5 py-4 sm:px-8">
          <p className="text-xs font-medium">{strings.practice}</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{strings.browser}</p>
        </div>
      </section>

      <div className="max-w-md space-y-7 lg:col-start-1 lg:row-start-2">
        <section aria-labelledby="demo-guidance">
          <h2 id="demo-guidance" className="text-sm font-semibold">{strings.guidanceTitle}</h2>
          <ul className="mt-3 list-disc space-y-1.5 ps-4 text-sm text-[var(--color-text-muted)]">{strings.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
        </section>
        <section aria-labelledby="demo-languages" className="space-y-2 border-t pt-6 text-sm">
          <h2 id="demo-languages" className="font-semibold">{strings.languageTitle}</h2>
          <p className="text-[var(--color-text-muted)]">{strings.languages}</p>
          <p className="text-[var(--color-text-muted)]">{strings.switching}</p>
        </section>
      </div>
    </div>
  </main>;
}
