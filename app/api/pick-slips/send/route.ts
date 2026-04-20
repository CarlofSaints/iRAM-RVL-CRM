import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rolesData';
import { listLoads } from '@/lib/agedStockData';
import { listAllPickSlipRuns, updateSlipInRun, type PickSlipRecord } from '@/lib/pickSlipData';
import { loadUsers } from '@/lib/userData';
import { clientScopeFor, filterClientIdsByScope } from '@/lib/clientScope';
import { loadControl } from '@/lib/controlData';
import { generatePickSlipPdf } from '@/lib/pickSlipPdf';
import { sendPickSlipEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

interface ClientRecord { id: string; name: string; vendorNumbers: string[] }

/**
 * POST /api/pick-slips/send — Send pick slips via email.
 *
 * Body: { slipIds: string[], to: string[], cc?: string[], bcc?: string[], sendMode: 'combined' | 'individual' }
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'manage_pick_slips');
  if (guard instanceof NextResponse) return guard;

  let body: {
    slipIds?: string[];
    to?: string[];
    cc?: string[];
    bcc?: string[];
    sendMode?: 'combined' | 'individual';
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const slipIds = Array.isArray(body.slipIds) ? body.slipIds : [];
  const to = Array.isArray(body.to) ? body.to.filter(Boolean) : [];
  const cc = Array.isArray(body.cc) ? body.cc.filter(Boolean) : [];
  const bcc = Array.isArray(body.bcc) ? body.bcc.filter(Boolean) : [];
  const sendMode = body.sendMode === 'individual' ? 'individual' : 'combined';

  if (slipIds.length === 0) {
    return NextResponse.json({ error: 'No slip IDs provided' }, { status: 400 });
  }
  if (to.length === 0) {
    return NextResponse.json({ error: 'At least one TO email is required' }, { status: 400 });
  }

  // Get user for scoping
  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  if (!me) return NextResponse.json({ error: 'User not found' }, { status: 401 });

  const scope = clientScopeFor({
    role: me.role,
    permissions: guard.permissions,
    linkedClientId: me.linkedClientId,
    assignedClientIds: me.assignedClientIds,
  });

  const allClients = await loadControl<ClientRecord>('clients');
  const scopedIds = filterClientIdsByScope(scope, allClients.map(c => c.id));
  const runs = await listAllPickSlipRuns(scopedIds, listLoads);

  // Build slip lookup from runs
  const slipMap = new Map<string, PickSlipRecord & { _loadId: string; _clientId: string }>();
  for (const run of runs) {
    for (const slip of run.slips) {
      slipMap.set(slip.id, { ...slip, _loadId: run.loadId, _clientId: run.clientId });
    }
  }

  // Collect requested slips
  const targetSlips: Array<PickSlipRecord & { _loadId: string; _clientId: string }> = [];
  const notFound: string[] = [];
  for (const id of slipIds) {
    const s = slipMap.get(id);
    if (s) targetSlips.push(s);
    else notFound.push(id);
  }

  if (targetSlips.length === 0) {
    return NextResponse.json({ error: 'None of the requested slips were found', notFound }, { status: 404 });
  }

  // Generate PDFs from stored rows
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  if (sendMode === 'combined') {
    // One email with all PDFs as attachments
    const attachments: Array<{ filename: string; content: Buffer }> = [];
    for (const slip of targetSlips) {
      try {
        const rows = slip.rows?.length ? slip.rows : [];
        if (rows.length === 0) {
          errors.push(`${slip.id}: no rows to generate PDF`);
          failed++;
          continue;
        }
        const pdfBuffer = await generatePickSlipPdf({
          pickSlipId: slip.id,
          clientName: slip.clientName || 'Unknown',
          vendorNumber: slip.vendorNumber,
          siteName: slip.siteName,
          siteCode: slip.siteCode,
          warehouse: slip.warehouse,
          loadDate: slip.generatedAt.slice(0, 10),
          rows,
        });
        attachments.push({ filename: slip.fileName, content: pdfBuffer });
      } catch (err) {
        errors.push(`${slip.id}: PDF gen failed — ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    if (attachments.length > 0) {
      try {
        const subjectParts = targetSlips.slice(0, 3).map(s => s.id).join(', ');
        const subject = targetSlips.length <= 3
          ? `Pick Slips: ${subjectParts}`
          : `Pick Slips: ${subjectParts} (+${targetSlips.length - 3} more)`;

        const bodyHtml = `
          <p style="margin:0 0 14px;">Please find the attached pick slip${attachments.length > 1 ? 's' : ''}.</p>
          <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
            ${targetSlips.map(s => `
              <tr>
                <td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">${s.id}</td>
                <td style="font-size:13px;">${s.clientName || ''} — ${s.siteName} (${s.siteCode})</td>
              </tr>
            `).join('')}
          </table>
        `;

        await sendPickSlipEmail({ to, cc, bcc, subject, bodyHtml, attachments });
        sent = attachments.length;
      } catch (err) {
        errors.push(`Email send failed: ${err instanceof Error ? err.message : String(err)}`);
        failed += attachments.length;
        sent = 0;
      }
    }
  } else {
    // Individual mode — one email per slip
    for (const slip of targetSlips) {
      try {
        const rows = slip.rows?.length ? slip.rows : [];
        if (rows.length === 0) {
          errors.push(`${slip.id}: no rows to generate PDF`);
          failed++;
          continue;
        }
        const pdfBuffer = await generatePickSlipPdf({
          pickSlipId: slip.id,
          clientName: slip.clientName || 'Unknown',
          vendorNumber: slip.vendorNumber,
          siteName: slip.siteName,
          siteCode: slip.siteCode,
          warehouse: slip.warehouse,
          loadDate: slip.generatedAt.slice(0, 10),
          rows,
        });

        const subject = `Pick Slip ${slip.id} — ${slip.clientName || ''} ${slip.vendorNumber} — ${slip.siteName}`;
        const bodyHtml = `
          <p style="margin:0 0 14px;">Please find the attached pick slip.</p>
          <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
            <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Pick Slip ID</td><td style="font-size:13px;">${slip.id}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Client</td><td style="font-size:13px;">${slip.clientName || ''}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Vendor #</td><td style="font-size:13px;">${slip.vendorNumber}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Store</td><td style="font-size:13px;">${slip.siteName} (${slip.siteCode})</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Warehouse</td><td style="font-size:13px;">${slip.warehouse}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Total Qty</td><td style="font-size:13px;">${slip.totalQty}</td></tr>
          </table>
        `;

        await sendPickSlipEmail({
          to, cc, bcc, subject,
          bodyHtml,
          attachments: [{ filename: slip.fileName, content: pdfBuffer }],
        });
        sent++;
      } catch (err) {
        errors.push(`${slip.id}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  }

  // Update status to 'sent' for successfully processed slips
  const now = new Date().toISOString();
  for (const slip of targetSlips) {
    // Only mark sent if the email was actually sent (no error for this slip)
    const hadError = errors.some(e => e.startsWith(slip.id));
    if (!hadError) {
      try {
        await updateSlipInRun(slip._clientId, slip._loadId, slip.id, {
          status: 'sent',
          sentAt: now,
        });
      } catch {
        // Best effort — don't fail the response
      }
    }
  }

  return NextResponse.json(
    { sent, failed, ...(errors.length > 0 ? { errors } : {}), ...(notFound.length > 0 ? { notFound } : {}) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
