import {AlertTriangle, Clock3} from 'lucide-react';

export interface OperationalNotice {
  id: string;
  tone: 'warning' | 'danger';
  title: string;
  body: string;
}

export function OperationalBanners({notices}: {notices: readonly OperationalNotice[]}) {
  if (notices.length === 0) return null;
  return <div className="mb-4 space-y-3">
    {notices.map((notice) => {
      const blocking = notice.tone === 'danger';
      const Icon = blocking ? AlertTriangle : Clock3;
      const colour = blocking ? 'var(--danger)' : 'var(--warning)';
      return <div key={notice.id} role={blocking ? 'alert' : 'status'} className="flex items-start gap-3 rounded-lg border bg-[var(--surface)] p-4" style={{borderColor: colour, color: colour}}>
        <Icon aria-hidden="true" className="mt-0.5 shrink-0" size={21}/>
        <div><h2 className="font-semibold">{notice.title}</h2><p className="mt-1 text-sm">{notice.body}</p></div>
      </div>;
    })}
  </div>;
}
