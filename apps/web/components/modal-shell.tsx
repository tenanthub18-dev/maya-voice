'use client';

import {useRouter} from 'next/navigation';
import {type ReactNode, type RefObject, useEffect, useRef} from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus<T extends HTMLElement>(open: boolean, onClose: () => void): {
  dialogRef: RefObject<T | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
} {
  const dialogRef = useRef<T>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = triggerRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (dialog instanceof HTMLDialogElement && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (dialog instanceof HTMLDialogElement && dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
      previousFocus?.focus();
    };
  }, [open]);

  return {dialogRef, triggerRef};
}

export function ModalShell({children, closeLabel, labelledBy, closeHref}: {children: ReactNode; closeLabel: string; labelledBy: string; closeHref: string}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        router.push(closeHref);
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [closeHref, router]);

  return <div className="fixed inset-0 z-50 flex justify-end"><button type="button" tabIndex={-1} aria-label={closeLabel} onClick={() => router.push(closeHref)} className="absolute inset-0 min-h-0 w-full bg-black/50"/><aside ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="relative h-full w-full overflow-y-auto border-l bg-[var(--surface)] p-5 shadow-2xl sm:max-w-md">{children}</aside></div>;
}
