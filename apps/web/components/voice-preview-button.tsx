'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {Play, RotateCcw} from 'lucide-react';

import type {Language} from '@/lib/data/types';

async function probeVoicePreview(unavailable: string): Promise<void> {
  const response = await fetch('/api/soniox/preview');
  const body = await response.json() as {reachable?: boolean};
  if (!response.ok || body.reachable !== true) throw new Error(unavailable);
}

export function VoicePreviewButton({language, label, unavailable, text}: {language: Language; label: string; unavailable: string; text: string}) {
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);

  const check = useCallback(async () => {
    setError('');
    try {
      await probeVoicePreview(unavailable);
      setReachable(true);
    } catch {
      setReachable(false);
      setError(unavailable);
    }
  }, [unavailable]);

  useEffect(() => {
    let active = true;
    void probeVoicePreview(unavailable).then(
      () => { if (active) setReachable(true); },
      () => {
        if (!active) return;
        setReachable(false);
        setError(unavailable);
      },
    );
    return () => {
      active = false;
      audio.current?.pause();
    };
  }, [unavailable]);

  const play = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/soniox/preview', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({language, text}),
      });
      if (!response.ok) {
        throw new Error(unavailable);
      }
      const url = URL.createObjectURL(await response.blob());
      audio.current?.pause();
      audio.current = new Audio(url);
      audio.current.addEventListener('ended', () => URL.revokeObjectURL(url), {once: true});
      await audio.current.play();
    } catch {
      setError(unavailable);
    } finally { setBusy(false); }
  };

  return <div className="text-right"><button type="button" disabled={!reachable || busy} aria-label={label} onClick={() => void play()} className="grid size-11 place-items-center rounded-full border text-[var(--accent-strong)] disabled:text-[var(--muted)]"><Play aria-hidden="true" size={18}/></button>{error && <button type="button" onClick={() => void check()} className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs text-[var(--danger)]"><RotateCcw aria-hidden="true" size={13}/>{unavailable}</button>}</div>;
}
