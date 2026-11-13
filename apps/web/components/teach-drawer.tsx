'use client';

import {X} from 'lucide-react';
import {useActionState, useState} from 'react';
import {useFormStatus} from 'react-dom';
import {saveTeaching} from '@/app/calls/[id]/actions';
import type {Language} from '@/lib/data';
import {useModalFocus} from './modal-shell';

interface Labels {
  open: string;
  title: string;
  description: string;
  field: string;
  save: string;
  saving: string;
  cancel: string;
  close: string;
}

export function TeachDrawer({callId, question, language, labels}: {callId: string; question: string; language: Language; labels: Labels}) {
  const [open, setOpen] = useState(false);
  const [, action] = useActionState(async (_saved: boolean, formData: FormData) => {
    const saved = await saveTeaching(false, formData);
    if (saved) setOpen(false);
    return saved;
  }, false);
  const {dialogRef, triggerRef} = useModalFocus<HTMLDialogElement>(open, () => setOpen(false));
  const titleId = `teach-title-${callId}`;
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold text-[var(--accent-strong)]">{labels.open}</button>
      <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClose={() => setOpen(false)} className="drawer ml-auto h-dvh max-h-none w-[min(100%,420px)] max-w-none border-l bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl">
        <div className="flex min-h-full flex-col p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div><h2 id={titleId} className="text-xl font-semibold">{labels.title}</h2><p className="mt-2 text-sm text-[var(--muted)]">{labels.description}</p></div>
            <button type="button" onClick={() => setOpen(false)} aria-label={labels.close} className="grid min-h-11 min-w-11 place-items-center rounded-lg border"><X aria-hidden="true" size={20}/></button>
          </div>
          <blockquote dir="auto" className="transcript mt-6 rounded-lg bg-[var(--surface-raised)] p-4 text-sm">{question}</blockquote>
          <form action={action} className="mt-6 flex flex-1 flex-col">
            <input type="hidden" name="callId" value={callId}/><input type="hidden" name="question" value={question}/><input type="hidden" name="language" value={language}/>
            <label htmlFor={`teach-${callId}-${question.length}`} className="font-semibold">{labels.field}</label>
            <textarea data-autofocus id={`teach-${callId}-${question.length}`} name="answer" required rows={5} className="mt-2 w-full rounded-lg border bg-[var(--background)] p-3"/>
            <div className="mt-auto flex gap-3 pt-6">
              <button type="button" onClick={() => setOpen(false)} className="min-h-11 flex-1 rounded-lg border px-4 font-semibold">{labels.cancel}</button>
              <SaveButton save={labels.save} saving={labels.saving}/>
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}

function SaveButton({save, saving}: {save: string; saving: string}) {
  const {pending} = useFormStatus();
  return <button type="submit" disabled={pending} className="min-h-11 flex-1 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:opacity-60">{pending ? saving : save}</button>;
}
