'use client';

import {Power} from 'lucide-react';
import {useFormStatus} from 'react-dom';
import {setAgentEnabled} from '@/app/home/actions';

export function AgentToggle({enabled, label, onLabel, offLabel, savingLabel}: {enabled: boolean; label: string; onLabel: string; offLabel: string; savingLabel: string}) {
  return (
    <form action={setAgentEnabled} className="flex items-center justify-between gap-4 rounded-lg border bg-[var(--surface)] p-4">
      <div><p className="font-semibold">{label}</p><p className="mt-1 text-sm text-[var(--muted)]">{enabled ? onLabel : offLabel}</p></div>
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <ToggleButton enabled={enabled} onLabel={onLabel} offLabel={offLabel} savingLabel={savingLabel} />
    </form>
  );
}

function ToggleButton({enabled, onLabel, offLabel, savingLabel}: {enabled: boolean; onLabel: string; offLabel: string; savingLabel: string}) {
  const {pending} = useFormStatus();
  return (
    <button type="submit" role="switch" aria-checked={enabled} aria-label={pending ? savingLabel : enabled ? onLabel : offLabel} disabled={pending} className={`relative min-h-11 w-[68px] shrink-0 rounded-full border-2 transition ${enabled ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border)] bg-[var(--surface-raised)]'}`}>
      <span className={`absolute top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-[var(--surface)] shadow-sm transition ${enabled ? 'left-[30px] text-[var(--accent-strong)]' : 'left-1 text-[var(--muted)]'}`}><Power aria-hidden="true" size={16}/></span>
    </button>
  );
}
