'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, authFetch } from '@/lib/useAuth';
import type { ParsedBooking } from '@/lib/talShared';

const input = 'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-primary)] outline-none';
const empty: ParsedBooking = { brn: '', bookingDate: '', timeSlot: '', supplierName: '', instructions: [] };

export default function TalImportPage() {
  useAuth('import_excel');
  const router = useRouter();
  const [form, setForm] = useState<ParsedBooking | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const readPdf = async (file: File) => {
    setBusy(true); setError(''); setNote(''); setFileName(file.name);
    const fd = new FormData();
    fd.append('file', file);
    const res = await authFetch('/api/tal/parse', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.error || 'Could not read the PDF'); setForm({ ...empty }); return; }
    const p: ParsedBooking = data.parsed;
    setForm(p);
    if (!data.textFound) setNote('This PDF has no readable text (probably a scan). Type the details in below.');
    else if (!p.brn || !p.instructions.length || p.instructions.some((i) => !i.qty)) setNote('Some details could not be read. Fill in the blanks below before saving.');
    else setNote(`Read ${p.instructions.length} instruction(s). Check them against the PDF, then save.`);
  };

  const setIns = (i: number, patch: Partial<{ instructionNo: string; qty: number }>) =>
    setForm((f) => f && { ...f, instructions: f.instructions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const save = async () => {
    if (!form) return;
    setBusy(true); setError('');
    const res = await authFetch('/api/tal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, sourceFileName: fileName }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.error || 'Save failed'); return; }
    router.push(`/tal/${data.booking.id}`);
  };

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Load Booking Confirmation</h1>
        <p className="text-sm text-gray-500">Upload the Bosch Booking Confirmation PDF. Nothing is saved until you check it and press Save.</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-wrap items-center gap-3">
        <label className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 cursor-pointer">
          {busy && !form ? 'Reading…' : 'Choose PDF'}
          <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) readPdf(f); e.target.value = ''; }} />
        </label>
        {fileName && <span className="text-sm text-gray-600">{fileName}</span>}
        <div className="flex-1" />
        {!form && <button onClick={() => setForm({ ...empty })} className="text-sm text-gray-500 hover:text-gray-700 underline">Type it in instead</button>}
      </div>

      {note && <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-3">{note}</div>}
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{error}</div>}

      {form && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm col-span-2">
              <span className="font-medium text-gray-700">Booking Reference Number</span>
              <input className={`${input} font-mono`} value={form.brn} onChange={(e) => setForm({ ...form, brn: e.target.value.toUpperCase() })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Date of Booking</span>
              <input type="date" className={input} value={form.bookingDate} onChange={(e) => setForm({ ...form, bookingDate: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Time Slot</span>
              <input type="time" className={input} value={form.timeSlot} onChange={(e) => setForm({ ...form, timeSlot: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm col-span-2">
              <span className="font-medium text-gray-700">Supplier</span>
              <input className={input} value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} />
            </label>
          </div>

          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Instruction Numbers</div>
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr><th className="py-1">Instruction Nr.</th><th className="py-1 w-28">Qty</th><th className="w-20" /></tr>
              </thead>
              <tbody>
                {form.instructions.map((x, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2"><input className={`${input} w-full font-mono`} value={x.instructionNo} onChange={(e) => setIns(i, { instructionNo: e.target.value.trim() })} /></td>
                    <td className="py-1 pr-2"><input type="number" min={1} className={`${input} w-full`} value={x.qty} onChange={(e) => setIns(i, { qty: Number(e.target.value) })} /></td>
                    <td className="py-1">
                      <button onClick={() => setForm({ ...form, instructions: form.instructions.filter((_, j) => j !== i) })} className="text-sm text-red-600 hover:underline">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between mt-2">
              <button onClick={() => setForm({ ...form, instructions: [...form.instructions, { instructionNo: '', qty: 1 }] })}
                className="text-sm text-[var(--color-primary)] hover:underline">+ Add instruction</button>
              <span className="text-sm text-gray-500">
                {form.instructions.length} instruction(s), {form.instructions.reduce((t, x) => t + (x.qty || 0), 0)} unit(s)
              </span>
            </div>
          </div>

          <div className="flex justify-end">
            <button onClick={save} disabled={busy} className="px-5 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save as Booking received'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
