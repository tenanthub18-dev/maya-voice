'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {BarChart3, BookOpen, Bot, CalendarDays, Home, MoreHorizontal, Phone, Settings, ShoppingBag, X} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import {isPublicRoute} from '@/lib/auth/routes';
import {navigationItems, type NavigationKey, splitMobileNavigation} from '@/lib/navigation';
import {LocaleSwitcher} from './locale-switcher';
import {LiveStatus, LiveSync} from './live-sync';
import {endSupportSession} from '@/app/admin/actions';

// Lucide React component API: https://lucide.dev/guide/packages/lucide-react
const icons = {home: Home, calls: Phone, bookings: CalendarDays, orders: ShoppingBag, agent: Bot, phone: BookOpen, analytics: BarChart3, settings: Settings} satisfies Record<NavigationKey, typeof Home>;
const mobileNavigation = splitMobileNavigation();

export function AppShell({
  children,
  demo,
  productName,
  restaurantName,
  restaurantId,
  revisionNonce = null,
  mode = demo ? 'demo' : 'supabase',
  supportView = null,
}: {
  children: ReactNode;
  demo: boolean;
  productName: string;
  restaurantName?: string;
  restaurantId?: string;
  revisionNonce?: string | null;
  mode?: 'demo' | 'supabase';
  supportView?: {sessionId: string; restaurantName: string; expiresLabel: string} | null;
}) {
  const pathname = usePathname();
  const nav = useTranslations('nav');
  const app = useTranslations('app');
  const admin = useTranslations('screens.admin');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreDialog = useRef<HTMLDialogElement>(null);
  const moreActive = mobileNavigation.more.some(({href}) => pathname === href);
  const liveLabels = {live: app('live'), reconnecting: app('reconnecting'), offline: app('offline'), demo: app('demo')};

  useEffect(() => {
    if (moreOpen && !moreDialog.current?.open) moreDialog.current?.showModal();
    if (!moreOpen && moreDialog.current?.open) moreDialog.current.close();
  }, [moreOpen]);

  if (isPublicRoute(pathname)) return <>{children}</>;

  const desktopNavigation = (
    <nav aria-label={productName} className="grid grid-cols-4 gap-1 md:flex md:flex-col md:gap-1">
      {navigationItems.map(({href, key}) => {
        const Icon = icons[key];
        const active = pathname === href;
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs font-medium transition md:justify-start md:px-3 md:text-sm ${active ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]'}`}>
            <Icon aria-hidden="true" size={19} /><span>{nav(key)}</span>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[256px_minmax(0,1fr)]">
      {restaurantId && <LiveSync revisionNonce={revisionNonce} restaurantId={restaurantId} mode={mode} />}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:bg-[var(--surface)] focus:p-3">{app('skip')}</a>
      <aside className="hidden border-r bg-[var(--color-surface)] px-4 py-5 md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-7">
        <div className="grid gap-3 border-b px-2 pb-5"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-[var(--radius-control)] bg-[var(--color-accent)] font-display text-xl font-semibold text-[var(--color-on-accent)]">{productName.charAt(0)}</span><span className="min-w-0"><span className="block font-display text-lg font-semibold tracking-tight">{productName}</span>{restaurantName && <span className="block truncate text-xs text-[var(--muted)]" title={restaurantName}>{restaurantName}</span>}</span></div>{restaurantId && <LiveStatus demo={demo} labels={liveLabels} />}</div>
        {desktopNavigation}<div className="mt-auto grid gap-2"><LocaleSwitcher /><form action="/auth/signout" method="post"><button className="min-h-11 w-full rounded-lg border px-3 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-raised)]">{app('signOut')}</button></form></div>
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-between gap-3 border-b bg-[var(--color-surface)] px-4 py-3 md:hidden"><span className="min-w-0"><span className="block font-display text-lg font-semibold">{productName}</span>{restaurantName && <span className="block truncate text-xs text-[var(--muted)]" title={restaurantName}>{restaurantName}</span>}{restaurantId && <span className="mt-1 block"><LiveStatus demo={demo} labels={liveLabels} /></span>}</span><LocaleSwitcher /></header>
        {supportView && <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm font-semibold md:px-8"><p>{admin('supportBanner', {restaurant: supportView.restaurantName, expires: supportView.expiresLabel})}</p><form action={endSupportSession}><input type="hidden" name="sessionId" value={supportView.sessionId}/><button className={buttonClass}>{admin('endSession')}</button></form></div>}
        <main id="main" className="mx-auto w-full max-w-[1440px] px-4 py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 md:px-8 md:py-10 md:pb-10 xl:px-10">{supportView && pathname !== '/admin' ? <fieldset disabled className="m-0 min-w-0 border-0 p-0">{children}</fieldset> : children}</main>
        <div className="fixed inset-x-0 bottom-0 z-30 h-[calc(4rem+env(safe-area-inset-bottom))] border-t bg-[var(--color-surface)] px-1 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_20px_rgb(20_23_18/.08)] md:hidden">
          <nav aria-label={nav('mobileLabel')} className="grid h-full grid-cols-5 gap-1">
            {mobileNavigation.primary.map(({href, key}) => {
              const Icon = icons[key];
              const active = pathname === href;
              return <Link key={href} href={href} aria-label={nav(key)} aria-current={active ? 'page' : undefined} className={`flex h-full min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] font-medium leading-none transition ${active ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]'}`}><Icon aria-hidden="true" size={19}/><span className="w-full truncate text-center">{nav(key)}</span></Link>;
            })}
            <button type="button" aria-label={nav('more')} aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls="mobile-more-menu" aria-current={moreActive ? 'page' : undefined} onClick={() => setMoreOpen(true)} className={`flex h-full min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] font-medium leading-none transition ${moreActive || moreOpen ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]'}`}><MoreHorizontal aria-hidden="true" size={19}/><span>{nav('more')}</span></button>
          </nav>
        </div>
        <dialog ref={moreDialog} id="mobile-more-menu" aria-labelledby="mobile-more-title" onCancel={() => setMoreOpen(false)} onClose={() => setMoreOpen(false)} className="motion-sheet fixed inset-x-0 bottom-0 top-auto m-0 max-h-[80dvh] w-full max-w-none rounded-t-[var(--radius-panel)] border-x-0 border-b-0 bg-[var(--color-surface)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-[var(--color-text)] shadow-[var(--shadow-3)] backdrop:bg-black/50 md:hidden">
          <div className="mx-auto max-w-lg">
            <div className="flex items-center justify-between gap-4"><h2 id="mobile-more-title" className="text-lg font-semibold">{nav('moreTitle')}</h2><button type="button" aria-label={nav('closeMore')} onClick={() => setMoreOpen(false)} className="grid min-h-11 min-w-11 place-items-center rounded-lg border"><X aria-hidden="true" size={20}/></button></div>
            <nav aria-label={nav('moreTitle')} className="mt-3 grid gap-1">
              {mobileNavigation.more.map(({href, key}) => {
                const Icon = icons[key];
                const active = pathname === href;
                return <Link key={href} href={href} aria-label={nav(key)} aria-current={active ? 'page' : undefined} onClick={() => setMoreOpen(false)} className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 font-medium transition ${active ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]'}`}><Icon aria-hidden="true" size={20}/><span>{nav(key)}</span></Link>;
              })}
            </nav>
            <form action="/auth/signout" method="post" className="mt-3 border-t pt-3"><button className="min-h-11 w-full rounded-lg border px-3 text-sm font-semibold text-[var(--muted)]">{app('signOut')}</button></form>
          </div>
        </dialog>
      </div>
    </div>
  );
}

const buttonClass = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold';
