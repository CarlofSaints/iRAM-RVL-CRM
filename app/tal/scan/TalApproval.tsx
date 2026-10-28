'use client';

import { useState } from 'react';
import { authFetch } from '@/lib/useAuth';
import { TAL_STATUS_LABELS, type TalUnitStatus } from '@/lib/talShared';

interface ApprovalRow {
  ticket: string;
  rrn: string;
  description: string;
  brn?: string;
  status?: TalUnitStatus;
  previousTicket?: string;
  alreadyApproved?: boolean;
  problem: string;
}

/**
 * Paste Takealot's return approval email(s): each RRN gets its Zendesk ticket,
 * which is what lets it be scanned on Return to TAL. Checked before saving.
 */
export default function TalApproval() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (dryRun: boolean) => {
    setBusy(true); setMsg(null);
    const res = await authFetch('/api/tal/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, dryRun }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: data.error || 'Could not read the approval' });
    const got: ApprovalRow[] = data.rows ?? [];
    // After saving, the saved rows read as approved so the Save button goes away.
    setRows(dryRun ? got : got.map((r) => (r.problem ? r : { ...r, alreadyApproved: true })));
    if (!dryRun) {
      setMsg({ ok: true, text: `${data.saved ?? 0} unit(s) approved for return. They can now be scanned below.` });
      setText('');
    }
  };

  const usable = rows?.filter((r) => !r.problem && !r.alreadyApproved).length ?? 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3">
      <button onClick={() => setOpen((v) => !v)} className="text-left">
        <div className="text-sm font-semibold text-gray-700">{open ? '▾' : '▸'} Load Takealot approval email</div>
        <div className="text-xs text-gray-500">Paste the approval email (or the whole forwarded thread). Flow reads each Zendesk ticket and the RRNs under it.</div>
      </button>
      {open && (
        <>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setRows(null); }} rows={8}
            placeholder="Please refer to Zendesk ticket #77125620 … RRN-AA488-QMYB …" aria-label="Approval email text"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono" />
          <div className="flex gap-2">
            <button onClick={() => send(true)} disabled={busy || !text.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
              Check
            </button>
            {rows && usable > 0 && (
              <button onClick={() => send(false)} disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
                Save {usable} approval(s)
              </button>
            )}
          </div>
          {msg && <div className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</div>}
          {rows && rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">Ticket</th><th className="px-3 py-2">RRN</th><th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Booking</th><th className="px-3 py-2">Now</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rrn} className={`border-t border-gray-100 ${r.problem ? 'text-red-700' : ''}`}>
                    <td className="px-3 py-2 font-mono">#{r.ticket}{r.previousTicket && <div className="text-xs text-amber-700">was #{r.previousTicket}</div>}</td>
                    <td className="px-3 py-2 font-mono">{r.rrn}</td>
                    <td className="px-3 py-2">{r.description || '—'}</td>
                    <td className="px-3 py-2 font-mono">{r.brn ?? '—'}</td>
                    <td className="px-3 py-2">{r.problem || (r.alreadyApproved ? 'Approved' : r.status ? TAL_STATUS_LABELS[r.status] : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
