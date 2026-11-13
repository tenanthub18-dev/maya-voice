import {ArrowRight, CheckCircle2, Clock3, PackageCheck, ReceiptText} from 'lucide-react';
import {getFormatter, getTranslations} from 'next-intl/server';
import {changeOrderStatus} from '@/app/orders/actions';
import {getDataSource, type Order, type OrderItem, type OrderStatus} from '@/lib/data';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {Badge, Card, EmptyState, PageHeader} from './ui';

const statuses: OrderStatus[] = ['new', 'in-progress', 'ready'];

export async function OrdersScreen({searchParams}: {searchParams: Record<string, string | string[] | undefined>}) {
  const source = getDataSource();
  const t = await getTranslations('screens.orders');
  const common = await getTranslations('common');
  const format = await getFormatter();
  const [restaurant, orders, items] = await Promise.all([getCurrentRestaurant(), source.listOrders(), source.listOrderItems()]);
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />;
  if (!orders.length) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/agent" /></>;

  return <>
    {header}
    {searchParams.error && <div role="alert" className="mb-4 rounded-lg border border-[var(--danger)] bg-[var(--surface)] p-3 text-[var(--danger)]">{t('error')}</div>}
    <div className="grid gap-4 md:grid-cols-3">{statuses.map((status) => {
      const rows = orders.filter((order) => order.status === status);
      const Icon = status === 'new' ? ReceiptText : status === 'in-progress' ? Clock3 : PackageCheck;
      return <section key={status} aria-labelledby={`orders-${status}`} className="min-w-0"><div className="mb-3 flex min-h-11 items-center justify-between gap-3"><h2 id={`orders-${status}`} className="flex items-center gap-2 font-semibold"><Icon aria-hidden="true" size={19} className="text-[var(--accent-strong)]"/>{t(`statuses.${status}`)}</h2><Badge>{rows.length}</Badge></div><div className="space-y-3">{rows.length ? rows.map((order) => <OrderTicket key={order.id} order={order} items={items.filter((item) => item.orderId === order.id)} timeZone={restaurant.timezone} t={t} common={common} format={format}/>) : <Card className="border-dashed text-center text-sm text-[var(--muted)]">{t('columnEmpty')}</Card>}</div></section>;
    })}</div>
  </>;
}

function OrderTicket({order, items, timeZone, t, common, format}: {order: Order; items: OrderItem[]; timeZone: string; t: Awaited<ReturnType<typeof getTranslations<'screens.orders'>>>; common: Awaited<ReturnType<typeof getTranslations<'common'>>>; format: Awaited<ReturnType<typeof getFormatter>>}) {
  return <Card><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">{t('ticket', {id: order.id.replace('order-', '')})}</p><h3 className="mt-1 font-semibold">{order.name}</h3></div><Badge tone={order.paidStatus === 'paid' ? 'success' : 'warning'}>{order.paidStatus === 'paid' && <CheckCircle2 aria-hidden="true" className="mr-1" size={14}/>} {common(order.paidStatus)}</Badge></div><div className="mt-4 space-y-3 border-y py-3">{items.map((item) => <div key={item.id} className="flex items-start justify-between gap-3"><div><p className="font-medium">{item.quantity} × {item.item}</p>{item.modifiers.length > 0 && <ul className="mt-1 text-sm text-[var(--muted)]">{item.modifiers.map((modifier) => <li key={modifier}>+ {modifier}</li>)}</ul>}</div><span className="tabular-nums">{format.number((item.priceCents * item.quantity + item.modifierPriceCents.reduce((sum, price) => sum + price * item.quantity, 0)) / 100, {style: 'currency', currency: 'CAD'})}</span></div>)}</div><dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm"><dt className="text-[var(--muted)]">{t('subtotal')}</dt><dd className="text-right tabular-nums">{format.number(order.subtotalCents / 100, {style: 'currency', currency: 'CAD'})}</dd><dt className="text-[var(--muted)]">{t('tax')}</dt><dd className="text-right tabular-nums">{format.number(order.taxCents / 100, {style: 'currency', currency: 'CAD'})}</dd><dt className="font-semibold">{t('total')}</dt><dd className="text-right font-semibold tabular-nums">{format.number(order.totalCents / 100, {style: 'currency', currency: 'CAD'})}</dd></dl><div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-[var(--surface-raised)] px-3 py-2"><span className="text-sm text-[var(--muted)]">{t('pickup')}</span><time className="font-semibold">{format.dateTime(new Date(order.pickupAt), {hour: 'numeric', minute: '2-digit', timeZone})}</time></div><div className="mt-3 flex flex-wrap gap-2">{statuses.filter((status) => status !== order.status).map((status) => <form key={status} action={changeOrderStatus} className="flex-1"><input type="hidden" name="id" value={order.id}/><input type="hidden" name="status" value={status}/><button className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-3 text-sm font-semibold">{t('moveTo', {status: t(`statuses.${status}`)})}<ArrowRight aria-hidden="true" size={16}/></button></form>)}</div></Card>;
}
