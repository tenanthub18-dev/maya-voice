import Link from 'next/link';
import type {ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes} from 'react';
import {AlertTriangle, ChevronDown, ChevronRight, Inbox, LoaderCircle, X} from 'lucide-react';

// Lucide React component API: https://lucide.dev/guide/packages/lucide-react
export const buttonBase = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 py-2 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50';
export const iconButtonBase = 'inline-grid min-h-11 min-w-11 place-items-center rounded-[var(--radius-control)] border transition-colors disabled:pointer-events-none disabled:opacity-50';
export const inputBase = 'min-h-11 w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-3 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]';
export const selectBase = 'min-h-11 w-full appearance-none rounded-[var(--radius-control)] border bg-[var(--color-surface)] py-2 pl-3 pr-10 text-[var(--color-text)] focus-visible:border-[var(--color-focus)]';
export const switchBase = 'relative inline-flex min-h-11 min-w-11 cursor-pointer items-center gap-3';
export const tabsTriggerBase = 'inline-flex min-h-11 shrink-0 snap-start items-center justify-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-semibold text-[var(--color-text-muted)] transition-colors aria-[current=page]:border-[var(--color-accent)] aria-[current=page]:text-[var(--color-text)]';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

export function buttonStyles(variant: ButtonVariant = 'primary', className = ''): string {
  const variants: Record<ButtonVariant, string> = {
    primary: 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:border-[var(--color-accent-hover)] hover:bg-[var(--color-accent-hover)]',
    secondary: 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]',
    quiet: 'border-transparent bg-transparent text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]',
    danger: 'border-[var(--color-danger)] bg-[var(--color-danger)] text-white hover:brightness-90',
  };
  return `${buttonBase} ${variants[variant]} ${className}`.trim();
}

export function Button({variant = 'primary', className = '', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: ButtonVariant}) {
  return <button className={buttonStyles(variant, className)} {...props}/>;
}

export function IconButton({label, className = '', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {label: string}) {
  return <button aria-label={label} className={`${iconButtonBase} bg-[var(--color-surface)] hover:bg-[var(--color-surface-raised)] ${className}`} {...props}/>;
}

export function Input({label, hint, error, id, className = '', ...props}: InputHTMLAttributes<HTMLInputElement> & {label: string; hint?: string; error?: string}) {
  const fieldId = id ?? props.name;
  const descriptionId = `${fieldId}-description`;
  return <label htmlFor={fieldId} className="grid gap-1 text-sm font-medium"><span>{label}</span><input id={fieldId} aria-invalid={Boolean(error)} aria-describedby={hint || error ? descriptionId : undefined} className={`${inputBase} ${error ? 'border-[var(--color-danger)]' : ''} ${className}`} {...props}/>{(hint || error) && <span id={descriptionId} className={`text-xs ${error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>{error ?? hint}</span>}</label>;
}

export function Select({label, id, children, className = '', labelClassName = '', ...props}: SelectHTMLAttributes<HTMLSelectElement> & {label: string; children: ReactNode; labelClassName?: string}) {
  const fieldId = id ?? props.name;
  return <label htmlFor={fieldId} className={`grid min-w-0 gap-1 text-sm font-medium ${labelClassName}`}><span>{label}</span><span className="relative block min-w-0"><select id={fieldId} className={`${selectBase} ${className}`} {...props}>{children}</select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" size={17}/></span></label>;
}

export function Switch({label, description, checked, ...props}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {label: string; description?: string}) {
  return <label className={switchBase}><input type="checkbox" role="switch" checked={checked} className="peer sr-only" {...props}/><span aria-hidden="true" className="relative h-6 w-11 shrink-0 rounded-full bg-[var(--color-border-strong)] after:absolute after:left-1 after:top-1 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-[var(--color-accent)] peer-checked:after:translate-x-5"/><span><span className="block text-sm font-semibold">{label}</span>{description && <span className="block text-xs text-[var(--color-text-muted)]">{description}</span>}</span></label>;
}

export function Tabs({children, label}: {children: ReactNode; label: string}) { return <div className="relative" data-scroll-fade="end"><nav aria-label={label} className="flex snap-x snap-mandatory gap-1 overflow-x-auto whitespace-nowrap border-b pe-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</nav><span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--color-canvas)] to-transparent md:hidden"/></div>; }
export function Tab({href, active, children}: {href: string; active: boolean; children: ReactNode}) { return <Link href={href} aria-current={active ? 'page' : undefined} className={tabsTriggerBase}>{children}</Link>; }

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export function Badge({children, tone = 'neutral', className = ''}: {children: ReactNode; tone?: Tone; className?: string}) {
  const tones: Record<Tone, string> = {neutral: 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]', accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]', success: 'bg-[var(--color-success-soft)] text-[var(--color-success)]', warning: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]', danger: 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'};
  return <span className={`inline-flex min-h-7 items-center rounded-[var(--radius-pill)] px-2.5 text-xs font-bold ${tones[tone]} ${className}`}>{children}</span>;
}
export const Chip = Badge;

export function Card({children, className = '', as: Element = 'section'}: {children: ReactNode; className?: string; as?: 'section' | 'article' | 'div'}) { return <Element className={`rounded-[var(--radius-panel)] border bg-[var(--color-surface)] p-4 shadow-[var(--shadow-1)] md:p-5 ${className}`}>{children}</Element>; }

export function PageHeader({eyebrow, title, description, actions}: {eyebrow: string; title: string; description: string; actions?: ReactNode}) {
  return <header className="mb-6 flex max-w-5xl flex-col justify-between gap-4 md:mb-8 md:flex-row md:items-end"><div className="max-w-3xl"><p className="mb-2 text-xs font-bold uppercase tracking-[var(--tracking-label)] text-[var(--color-accent)]">{eyebrow}</p><h1 className="text-[length:var(--text-3xl)] font-semibold leading-[var(--leading-tight)] tracking-[var(--tracking-tight)]">{title}</h1><p className="mt-2 max-w-2xl text-[var(--color-text-muted)]">{description}</p></div>{actions && <div className="shrink-0">{actions}</div>}</header>;
}

export function Dialog({open, title, description, closeLabel, onClose, children}: {open: boolean; title: string; description?: string; closeLabel: string; onClose?: () => void; children: ReactNode}) {
  if (!open) return null;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--color-overlay)_62%,transparent)] p-4"><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="w-full max-w-lg rounded-[var(--radius-panel)] border bg-[var(--color-surface)] p-5 shadow-[var(--shadow-3)]"><header className="flex items-start justify-between gap-4"><div><h2 id="dialog-title" className="text-xl font-semibold">{title}</h2>{description && <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>}</div>{onClose && <IconButton label={closeLabel} onClick={onClose}><X aria-hidden size={20}/></IconButton>}</header><div className="mt-5">{children}</div></section></div>;
}

export function Sheet({title, description, closeLabel, onClose, children, className = ''}: {title: string; description?: string; closeLabel: string; onClose: () => void; children: ReactNode; className?: string}) {
  return <aside role="dialog" aria-modal="true" aria-labelledby="sheet-title" className={`motion-sheet h-full w-full overflow-y-auto border-l bg-[var(--color-surface)] p-5 shadow-[var(--shadow-3)] sm:max-w-md ${className}`}><header className="flex items-start justify-between gap-4"><div><h2 id="sheet-title" className="text-xl font-semibold">{title}</h2>{description && <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>}</div><IconButton label={closeLabel} onClick={onClose}><X aria-hidden size={20}/></IconButton></header>{children}</aside>;
}

export function Toast({title, description, tone = 'neutral'}: {title: string; description?: string; tone?: Tone}) { return <div role={tone === 'danger' ? 'alert' : 'status'} className="flex max-w-sm items-start gap-3 rounded-[var(--radius-panel)] border bg-[var(--color-surface)] p-4 shadow-[var(--shadow-2)]"><Badge tone={tone}>{title}</Badge>{description && <p className="text-sm text-[var(--color-text-muted)]">{description}</p>}</div>; }
export function Skeleton({className = ''}: {className?: string}) { return <span aria-hidden="true" className={`motion-skeleton block rounded-[var(--radius-control)] bg-[var(--color-surface-raised)] ${className}`}/>; }
export function Skeletons() { return <div aria-busy="true" className="space-y-6"><Skeleton className="h-4 w-32"/><Skeleton className="h-12 w-3/4"/><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({length: 4}, (_, index) => <Skeleton key={index} className="h-28"/>)}</div><Skeleton className="h-64"/></div>; }

export function EmptyState({message, action, href, icon}: {message: string; action: string; href: string; icon?: ReactNode}) { return <Card className="grid min-h-64 place-items-center border-dashed text-center"><div className="max-w-sm">{icon ?? <Inbox aria-hidden className="mx-auto text-[var(--color-text-muted)]" size={28}/>}<p className="mt-3 text-[var(--color-text-muted)]">{message}</p><Link href={href} className={buttonStyles('primary', 'mt-5')}>{action}<ChevronRight aria-hidden size={17}/></Link></div></Card>; }
export function ErrorState({title, message, retryLabel, onRetry}: {title: string; message: string; retryLabel: string; onRetry: () => void}) { return <Card className="grid min-h-64 place-items-center text-center"><div className="max-w-md"><AlertTriangle aria-hidden className="mx-auto text-[var(--color-danger)]" size={28}/><h2 className="mt-3 text-xl font-semibold">{title}</h2><p className="mt-2 text-[var(--color-text-muted)]">{message}</p><Button onClick={onRetry} className="mt-5">{retryLabel}</Button></div></Card>; }

export interface DataTableColumn<Row> {key: string; header: ReactNode; cell: (row: Row) => ReactNode; numeric?: boolean; mobileLabel?: ReactNode}
export function DataTable<Row>({rows, columns, rowKey, caption}: {rows: Row[]; columns: DataTableColumn<Row>[]; rowKey: (row: Row) => string; caption: string}) {
  return <><div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><caption className="sr-only">{caption}</caption><thead><tr className="border-b text-[var(--color-text-muted)]">{columns.map((column) => <th key={column.key} scope="col" className={`p-3 ${column.numeric ? 'text-right' : ''}`}>{column.header}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={rowKey(row)} className="border-b last:border-0">{columns.map((column, index) => index === 0 ? <th key={column.key} scope="row" className="p-3 font-semibold">{column.cell(row)}</th> : <td key={column.key} className={`p-3 ${column.numeric ? 'text-right tabular-nums' : ''}`}>{column.cell(row)}</td>)}</tr>)}</tbody></table></div><div className="divide-y md:hidden">{rows.map((row) => <article key={rowKey(row)} className="grid grid-cols-2 gap-x-4 gap-y-2 py-4">{columns.map((column, index) => <div key={column.key} className={index === 0 ? 'col-span-2' : ''}>{index > 0 && <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{column.mobileLabel ?? column.header}</p>}<div className={`mt-0.5 ${column.numeric ? 'tabular-nums' : ''}`}>{column.cell(row)}</div></div>)}</article>)}</div></>;
}

export function StatTile({label, value, detail, icon}: {label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode}) { return <Card className="relative overflow-hidden"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-[var(--color-text-muted)]">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>{detail && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{detail}</p>}</div>{icon && <span className="text-[var(--color-accent)]">{icon}</span>}</div></Card>; }
export const Stat = StatTile;

export function TranscriptBubble({speaker, meta, children, action}: {speaker: 'agent' | 'caller'; meta: ReactNode; children: ReactNode; action?: ReactNode}) { return <article dir="auto" className={`transcript max-w-[92%] rounded-[var(--radius-panel)] p-3 sm:max-w-[78%] ${speaker === 'agent' ? 'ms-auto border border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'me-auto bg-[var(--color-surface-raised)]'}`}><div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold text-[var(--color-text-muted)]">{meta}</div><div dir="auto">{children}</div>{action && <div className="mt-3 border-t pt-2 text-end">{action}</div>}</article>; }
export const TimelineBubble = TranscriptBubble;

export interface LatencyStage {key: string; label: string; p50Label: string; p95Label: string; p50: ReactNode; p95: ReactNode; status?: 'good' | 'warning'}
export function LatencyStrip({stages}: {stages: LatencyStage[]}) { return <div className="grid grid-cols-2 gap-2 md:grid-cols-5">{stages.map((stage) => <div key={stage.key} className={`rounded-[var(--radius-control)] border p-3 ${stage.status === 'warning' ? 'border-[var(--color-warning)] bg-[var(--color-warning-soft)]' : 'bg-[var(--color-canvas)]'}`}><p className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{stage.label}</p><p className="mt-2 text-sm tabular-nums"><span className="text-[var(--color-text-muted)]">{stage.p50Label} </span><strong>{stage.p50}</strong></p><p className="mt-1 text-sm tabular-nums"><span className="text-[var(--color-text-muted)]">{stage.p95Label} </span><strong>{stage.p95}</strong></p></div>)}</div>; }
export function CapacityBar({label, value, max, detail}: {label: string; value: number; max: number; detail?: ReactNode}) { const percent = max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : 0; return <div><div className="mb-1 flex justify-between gap-3 text-sm"><span>{label}</span><strong className="tabular-nums">{detail ?? `${value}/${max}`}</strong></div><div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"><div className="h-full rounded-full bg-[var(--color-accent)]" style={{width: `${percent}%`}}/></div></div>; }

export interface CalendarCell {id: string; label: ReactNode; value?: ReactNode; muted?: boolean; selected?: boolean}
export function CalendarGrid({cells, columns = 7, label}: {cells: CalendarCell[]; columns?: number; label: string}) { return <div role="grid" aria-label={label} className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border bg-[var(--color-border)]" style={{gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`}}>{cells.map((cell) => <div role="gridcell" aria-selected={cell.selected} key={cell.id} className={`min-h-16 bg-[var(--color-surface)] p-2 ${cell.muted ? 'text-[var(--color-text-muted)]' : ''} ${cell.selected ? 'outline outline-2 -outline-offset-2 outline-[var(--color-accent)]' : ''}`}><span className="text-xs font-semibold">{cell.label}</span>{cell.value && <div className="mt-1 tabular-nums">{cell.value}</div>}</div>)}</div>; }
export function LoadingButton({children, loading, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {loading: boolean}) { return <Button disabled={loading || props.disabled} {...props}>{loading && <LoaderCircle aria-hidden className="animate-spin" size={16}/>} {children}</Button>; }
