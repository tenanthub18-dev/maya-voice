import Link from 'next/link';
import {CalendarDays, ChevronLeft, ChevronRight, List, Pencil, Plus, X} from 'lucide-react';
import {getFormatter, getTranslations} from 'next-intl/server';
import {changeBookingStatus, saveBooking} from '@/app/bookings/actions';
import {addCalendarDays, formatDateKey, localInputValue} from '@/lib/bookings/calendar';
import {getDataSource, type Booking, type Hours, type HoursOverride, type SlotsConfig} from '@/lib/data';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {Badge, CapacityBar, Card, EmptyState, PageHeader, Select, buttonStyles, inputBase} from './ui';
import {ModalShell} from './modal-shell';

type View = 'day' | 'week' | 'list';
type Params = Record<string, string | string[] | undefined>;

export async function BookingsScreen({searchParams}: {searchParams: Params}) {
  const source = getDataSource();
  const t = await getTranslations('screens.bookings');
  const common = await getTranslations('common');
  const format = await getFormatter();
  const [restaurant, config, bookings, hours, overrides] = await Promise.all([
    getCurrentRestaurant(), source.getSlotsConfig(), source.listBookings(), source.listHours(), source.listHoursOverrides()
  ]);
  const now = new Date();
  const value = (key: string) => typeof searchParams[key] === 'string' ? searchParams[key] : undefined;
  const view: View = ['day', 'week', 'list'].includes(value('view') ?? '') ? value('view') as View : 'day';
  const today = formatDateKey(now, restaurant.timezone);
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(value('date') ?? '') ? value('date')! : today;
  const editedBooking = bookings.find((booking) => booking.id === value('edit'));
  const drawerOpen = value('create') === '1' || Boolean(editedBooking);
  const error = value('error');
  const errorKeys: Record<string, string> = {NAME_REQUIRED: 'nameRequired', PHONE_INVALID: 'phoneInvalid', PARTY_SIZE_INVALID: 'partyInvalid', MAX_PARTY: 'maxParty', START_INVALID: 'startInvalid', LEAD_TIME: 'leadTime', BOOKING_WINDOW: 'bookingWindow', BLACKOUT_DATE: 'blackout', CAPACITY: 'capacityFull', UNKNOWN: 'unknown'};
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />;

  if (!bookings.length && !drawerOpen) {
    return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/bookings?create=1" /></>;
  }

  return <>
    <div className="flex items-start justify-between gap-4">
      {header}
      <Link href="/bookings?create=1" aria-label={t('action')} className={buttonStyles('primary', 'shrink-0')}><Plus aria-hidden="true" size={18}/><span className="hidden sm:inline">{t('action')}</span></Link>
    </div>
    {value('saved') === '1' && <div role="status" className="mb-4 rounded-lg border border-[var(--success)] bg-[var(--surface)] p-3 text-[var(--success)]">{t('saved')}</div>}
    {error && <div role="alert" className="mb-4 rounded-lg border border-[var(--danger)] bg-[var(--surface)] p-3 text-[var(--danger)]">{t(`errors.${errorKeys[error] ?? 'unknown'}`, {max: config.maxParty, minutes: config.leadTimeMinutes, days: config.bookingWindowDays})}</div>}
    <Card className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t('viewLabel')} className="flex rounded-lg bg-[var(--surface-raised)] p-1">
          {(['day', 'week', 'list'] as const).map((item) => <Link key={item} href={`/bookings?view=${item}&date=${selectedDate}`} aria-current={view === item ? 'page' : undefined} className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3 font-semibold ${view === item ? 'bg-[var(--surface)] text-[var(--accent-strong)] shadow-sm' : 'text-[var(--muted)]'}`}>{item === 'list' ? <List aria-hidden="true" size={17}/> : <CalendarDays aria-hidden="true" size={17}/>}<span>{t(`views.${item}`)}</span></Link>)}
        </nav>
        {view !== 'list' && <form className="flex items-center gap-2" method="get"><input type="hidden" name="view" value={view}/><label className="sr-only" htmlFor="booking-date">{t('chooseDate')}</label><input id="booking-date" name="date" type="date" defaultValue={selectedDate} className="min-h-11 rounded-lg border bg-[var(--background)] px-3"/><button className="min-h-11 rounded-lg border px-3 font-semibold">{t('go')}</button></form>}
      </div>
    </Card>
    {view === 'list' ? <BookingList bookings={bookings} timeZone={restaurant.timezone} format={format} t={t} common={common}/> : <CalendarView view={view} selectedDate={selectedDate} bookings={bookings} hours={hours} overrides={overrides} config={config} timeZone={restaurant.timezone} format={format} t={t}/>}
    {drawerOpen && <BookingDrawer booking={editedBooking} config={config} now={now} timeZone={restaurant.timezone} t={t}/>}
  </>;
}

function CalendarView({view, selectedDate, bookings, hours, overrides, config, timeZone, format, t}: {view: Exclude<View, 'list'>; selectedDate: string; bookings: Booking[]; hours: Hours[]; overrides: HoursOverride[]; config: SlotsConfig; timeZone: string; format: Awaited<ReturnType<typeof getFormatter>>; t: Awaited<ReturnType<typeof getTranslations<'screens.bookings'>>>}) {
  const dates = Array.from({length: view === 'week' ? 7 : 1}, (_, index) => addCalendarDays(selectedDate, index));
  const step = view === 'week' ? 7 : 1;
  return <>
    <div className="mb-4 flex items-center justify-between gap-3"><Link href={`/bookings?view=${view}&date=${addCalendarDays(selectedDate, -step)}`} aria-label={t('previous')} className="grid size-11 place-items-center rounded-lg border bg-[var(--surface)]"><ChevronLeft aria-hidden="true"/></Link><strong className="text-center">{view === 'day' ? format.dateTime(new Date(`${selectedDate}T12:00:00.000Z`), {dateStyle: 'full', timeZone: 'UTC'}) : t('weekOf', {date: format.dateTime(new Date(`${selectedDate}T12:00:00.000Z`), {dateStyle: 'medium', timeZone: 'UTC'})})}</strong><Link href={`/bookings?view=${view}&date=${addCalendarDays(selectedDate, step)}`} aria-label={t('next')} className="grid size-11 place-items-center rounded-lg border bg-[var(--surface)]"><ChevronRight aria-hidden="true"/></Link></div>
    <div className={view === 'week' ? 'grid gap-3 md:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7' : ''}>{dates.map((date) => <CalendarDay key={date} date={date} bookings={bookings} hours={hours} overrides={overrides} config={config} timeZone={timeZone} format={format} t={t}/>)}</div>
  </>;
}

function CalendarDay({date, bookings, hours, overrides, config, timeZone, format, t}: {date: string; bookings: Booking[]; hours: Hours[]; overrides: HoursOverride[]; config: SlotsConfig; timeZone: string; format: Awaited<ReturnType<typeof getFormatter>>; t: Awaited<ReturnType<typeof getTranslations<'screens.bookings'>>>}) {
  const override = overrides.find((row) => row.date === date);
  const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  const regularHours = hours.find((row) => row.weekday === weekday);
  const openTime = override ? override.openTime : regularHours?.openTime;
  const closeTime = override ? override.closeTime : regularHours?.closeTime;
  const dayBookings = bookings.filter((booking) => booking.status !== 'cancelled' && booking.status !== 'no-show' && formatDateKey(new Date(booking.startsAt), timeZone) === date);
  if (!openTime || !closeTime) return <Card><h2 className="font-semibold">{format.dateTime(new Date(`${date}T12:00:00.000Z`), {weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC'})}</h2><p className="mt-4 text-[var(--muted)]">{t('blackout')}</p></Card>;
  const startMinutes = timeToMinutes(openTime);
  const endMinutes = timeToMinutes(closeTime);
  const slots = Array.from({length: Math.max(0, Math.floor((endMinutes - startMinutes) / config.slotMinutes))}, (_, index) => startMinutes + index * config.slotMinutes);
  return <Card><h2 className="mb-3 font-semibold">{format.dateTime(new Date(`${date}T12:00:00.000Z`), {weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC'})}</h2><div className="space-y-3">{slots.map((slot) => {
    const covers = dayBookings.reduce((sum, booking) => {
      const start = timeToMinutes(localInputValue(new Date(booking.startsAt), timeZone).slice(11));
      return slot >= start && slot < start + config.seatingMinutes ? sum + booking.partySize : sum;
    }, 0);
    return <div key={slot} role="progressbar" aria-label={t('slotCapacity', {time: minutesToTime(slot)})} aria-valuemin={0} aria-valuemax={config.coversPerSlot} aria-valuenow={covers} aria-valuetext={t('coversUsed', {covers, capacity: config.coversPerSlot})}><CapacityBar label={minutesToTime(slot)} value={covers} max={config.coversPerSlot}/></div>;
  })}</div></Card>;
}

function BookingList({bookings, timeZone, format, t, common}: {bookings: Booking[]; timeZone: string; format: Awaited<ReturnType<typeof getFormatter>>; t: Awaited<ReturnType<typeof getTranslations<'screens.bookings'>>>; common: Awaited<ReturnType<typeof getTranslations<'common'>>>}) {
  const sorted = [...bookings].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return <Card><h2 className="mb-3 font-semibold">{t('upcoming')}</h2><div className="divide-y">{sorted.map((booking) => <article key={booking.id} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-center"><div><div className="flex flex-wrap items-center gap-2"><strong>{booking.name}</strong><Badge tone={booking.status === 'confirmed' || booking.status === 'seated' ? 'success' : 'warning'}>{t(`statuses.${booking.status}`)}</Badge><Badge tone={booking.paidStatus === 'paid' ? 'success' : 'warning'}>{common(booking.paidStatus)}</Badge></div><p className="mt-1 text-sm text-[var(--muted)]">{format.dateTime(new Date(booking.startsAt), {dateStyle: 'medium', timeStyle: 'short', timeZone})} · {t('partyCount', {count: booking.partySize})}</p>{booking.notes && <p className="mt-1 text-sm">{booking.notes}</p>}</div><div className="flex min-w-0 flex-wrap items-center gap-2"><form action={changeBookingStatus} className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-2"><input type="hidden" name="id" value={booking.id}/><Select id={`status-${booking.id}`} name="status" label={t('status')} labelClassName="[&>span:first-child]:sr-only" defaultValue={booking.status}>{(['confirmed', 'seated', 'cancelled', 'no-show'] as const).map((status) => <option key={status} value={status}>{t(`statuses.${status}`)}</option>)}</Select><button className="min-h-11 rounded-lg border px-3 font-semibold">{t('update')}</button></form><Link href={`/bookings?view=list&edit=${booking.id}`} aria-label={t('editBooking', {name: booking.name})} className="grid size-11 shrink-0 place-items-center rounded-lg border"><Pencil aria-hidden="true" size={17}/></Link></div></article>)}</div></Card>;
}

function BookingDrawer({booking, config, now, timeZone, t}: {booking?: Booking; config: SlotsConfig; now: Date; timeZone: string; t: Awaited<ReturnType<typeof getTranslations<'screens.bookings'>>>}) {
  const earliest = roundUp(new Date(now.getTime() + config.leadTimeMinutes * 60_000), config.slotMinutes);
  const startsAt = booking ? localInputValue(new Date(booking.startsAt), timeZone) : localInputValue(earliest, timeZone);
  const maxDate = addCalendarDays(formatDateKey(now, timeZone), config.bookingWindowDays);
  return <ModalShell closeLabel={t('close')} labelledBy="booking-drawer-title" closeHref="/bookings?view=list"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[var(--accent-strong)]">{t('drawerEyebrow')}</p><h2 id="booking-drawer-title" className="mt-2 text-2xl font-semibold">{booking ? t('editTitle') : t('createTitle')}</h2></div><Link href="/bookings?view=list" aria-label={t('close')} className="grid size-11 place-items-center rounded-lg border"><X aria-hidden="true"/></Link></div><form action={saveBooking} className="mt-6 space-y-4">{booking && <input type="hidden" name="id" value={booking.id}/>}<Field label={t('name')} name="name" defaultValue={booking?.name} required/><Field label={t('phone')} name="phoneE164" type="tel" defaultValue={booking?.phoneE164} placeholder={t('phonePlaceholder')} required/><Field label={t('partySize')} name="partySize" type="number" min="1" max={String(config.maxParty)} defaultValue={String(booking?.partySize ?? 2)} required/><Field label={t('startsAt')} name="startsAt" type="datetime-local" min={localInputValue(earliest, timeZone)} max={`${maxDate}T23:59`} step={String(config.slotMinutes * 60)} defaultValue={startsAt} required/><label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{t('notes')}</span><textarea name="notes" defaultValue={booking?.notes} rows={4} className="w-full rounded-lg border bg-[var(--background)] px-3 py-2"/></label><p className="text-sm text-[var(--muted)]">{t('rules', {max: config.maxParty, minutes: config.leadTimeMinutes, days: config.bookingWindowDays})}</p><button className="min-h-11 w-full rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{booking ? t('saveChanges') : t('create')}</button></form></ModalShell>;
}

function Field({label, name, type = 'text', defaultValue, required, ...rest}: {label: string; name: string; type?: string; defaultValue?: string; required?: boolean; [key: string]: string | boolean | undefined}) {
  return <label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{label}</span><input name={name} type={type} defaultValue={defaultValue} required={required} {...rest} className={inputBase}/></label>;
}

function timeToMinutes(value: string): number { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
function minutesToTime(value: number): string { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function roundUp(date: Date, minutes: number): Date { return new Date(Math.ceil(date.getTime() / (minutes * 60_000)) * minutes * 60_000); }
