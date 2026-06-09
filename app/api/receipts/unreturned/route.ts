import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, loadRoles } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';
import { updateSlipInRun, getPickSlipRun, type UnreturnedStockRow } from '@/lib/pickSlipData';
import { loadControl } from '@/lib/controlData';
import { logAudit } from '@/lib/auditLog';
import { sendUnreturnedSkipEmail, sendUnreturnedStockEmail } from '@/lib/email';
import { generateUnreturnedStockExcel } from '@/lib/unreturnedStockExcel';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receipts/unreturned
 *
 * Save unreturned stock capture data (reason codes per product),
 * or skip the capture with a notification email to managers.
 */
export async function POST(req: NextRequest) {
  const guard = await requirePermission(req, 'receipt_stock');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const { slipId, clientId, loadId } = body as {
    slipId: string;
    clientId: string;
    loadId: string;
  };

  if (!slipId || !clientId || !loadId) {
    return NextResponse.json({ error: 'slipId, clientId, and loadId are required' }, { status: 400 });
  }

  const users = await loadUsers();
  const me = users.find(u => u.id === guard.userId);
  const userName = me ? `${me.name} ${me.surname}` : guard.userId;

  // Fetch the current slip to read rows for validation
  const run = await getPickSlipRun(clientId, loadId);
  const slip = run?.slips.find(s => s.id === slipId);
  if (!slip) {
    return NextResponse.json({ error: 'Pick slip not found' }, { status: 404 });
  }

  // ── Skip flow ──
  if (body.skip === true) {
    const { skipRepId, skipRepName, skipReason } = body as {
      skipRepId: string;
      skipRepName: string;
      skipReason: string;
    };

    if (!skipRepId || !skipRepName) {
      return NextResponse.json({ error: 'skipRepId and skipRepName are required' }, { status: 400 });
    }

    const updated = await updateSlipInRun(clientId, loadId, slipId, {
      unreturnedSkipped: true,
      unreturnedSkipReason: skipReason || 'Rep did not return paperwork',
      unreturnedSkipRepId: skipRepId,
      unreturnedSkipRepName: skipRepName,
      unreturnedCapturedAt: new Date().toISOString(),
      unreturnedCapturedBy: guard.userId,
      unreturnedCapturedByName: userName,
    });

    // Send email to RVL Managers + Super Admins
    const adminEmails = users
      .filter(u => u.role === 'rvl-manager' || u.role === 'super-admin')
      .map(u => u.email)
      .filter(Boolean);

    if (adminEmails.length > 0) {
      try {
        await sendUnreturnedSkipEmail({
          toAdmins: adminEmails,
          skippedByName: userName,
          repName: skipRepName,
          storeName: slip.siteName,
          clientName: slip.clientName,
          pickSlipRef: slip.id,
          boxBarcodes: (slip.receiptBoxes ?? []).map(b => b.stickerBarcode),
          generatedAt: slip.generatedAt,
          bookedAt: slip.bookedAt,
          receiptedAt: slip.receiptedAt,
        });
      } catch (err) {
        console.error('[unreturned] Failed to send skip email:', err);
      }
    }

    await logAudit({
      action: 'unreturned_stock_skipped',
      userId: guard.userId,
      userName,
      slipId,
      clientId,
      detail: `Unreturned stock capture skipped for ${slipId}. Rep: ${skipRepName}. Reason: ${skipReason || 'Rep did not return paperwork'}`,
    });

    return NextResponse.json(
      { ok: true, slip: updated },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── Normal capture flow ──
  const { rows, sendEmail, ccSecondary } = body as {
    rows: UnreturnedStockRow[];
    sendEmail?: boolean;
    ccSecondary?: boolean;
  };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'rows are required' }, { status: 400 });
  }

  // Validate each row: sum of reasons cannot exceed pickSlipQty
  for (const row of rows) {
    const sum = (row.display || 0) + (row.storeRefused || 0) + (row.notFound || 0) + (row.damaged || 0);
    if (sum > row.pickSlipQty) {
      return NextResponse.json(
        { error: `Reason totals exceed pick slip qty for ${row.description} (${sum} > ${row.pickSlipQty})` },
        { status: 400 },
      );
    }
  }

  const updated = await updateSlipInRun(clientId, loadId, slipId, {
    unreturnedStock: rows,
    unreturnedCapturedAt: new Date().toISOString(),
    unreturnedCapturedBy: guard.userId,
    unreturnedCapturedByName: userName,
  });

  await logAudit({
    action: 'unreturned_stock_captured',
    userId: guard.userId,
    userName,
    slipId,
    clientId,
    detail: `Unreturned stock captured for ${slipId} — ${rows.length} products`,
  });

  // ── Send confirmation email ──
  let emailSent = false;
  let emailError = '';
  if (sendEmail) {
    try {
      // Load stores to find store details
      interface StoreRecord {
        siteCode: string;
        managerEmail?: string;
        iramRepEmailPrimary?: string;
        iramRepEmailSecondary?: string;
        [key: string]: unknown;
      }
      const stores = await loadControl<StoreRecord>('stores');
      const store = stores.find(s => s.siteCode === slip.siteCode);

      // Find the collecting rep's email
      const bookedRep = users.find(u => u.id === slip.bookedRepId);

      // Find CAM users — users whose role contains 'cam' and who are assigned to this client
      const roles = await loadRoles();
      const camRoleIds = roles.filter(r => r.id.toLowerCase().includes('cam')).map(r => r.id);
      const camUsers = users.filter(u =>
        camRoleIds.includes(u.role) &&
        (u.assignedClientIds ?? []).includes(slip.clientId),
      );

      // Find RVL managers
      const rvlManagers = users.filter(u => u.role === 'rvl-manager');

      // Build recipient list
      const toEmails: string[] = [];
      if (store?.managerEmail) toEmails.push(store.managerEmail);
      if (bookedRep?.email) toEmails.push(bookedRep.email);
      if (store?.iramRepEmailPrimary) toEmails.push(store.iramRepEmailPrimary);
      for (const u of rvlManagers) {
        if (u.email && !toEmails.includes(u.email)) toEmails.push(u.email);
      }
      for (const u of camUsers) {
        if (u.email && !toEmails.includes(u.email)) toEmails.push(u.email);
      }

      const ccEmails: string[] = [];
      if (ccSecondary && store?.iramRepEmailSecondary) {
        ccEmails.push(store.iramRepEmailSecondary);
      }

      if (toEmails.length === 0) {
        emailError = 'No recipients found — check store manager email, rep emails, and RVL manager accounts';
      } else {
        // Calculate totals
        let totalUplifted = 0;
        let totalNotUplifted = 0;
        const summary = rows.map(r => {
          const collected = r.pickSlipQty - ((r.display || 0) + (r.storeRefused || 0) + (r.notFound || 0) + (r.damaged || 0));
          totalUplifted += Math.max(0, collected);
          totalNotUplifted += (r.display || 0) + (r.storeRefused || 0) + (r.notFound || 0) + (r.damaged || 0);
          return {
            description: r.description,
            pickSlipQty: r.pickSlipQty,
            collected: Math.max(0, collected),
            display: r.display || 0,
            storeRefused: r.storeRefused || 0,
            notFound: r.notFound || 0,
            damaged: r.damaged || 0,
          };
        });

        // Estimate uplifted value proportionally
        const totalUpliftedVal = slip.totalVal > 0 && slip.totalQty > 0
          ? (totalUplifted / slip.totalQty) * slip.totalVal
          : 0;

        const captureDate = new Date().toLocaleDateString('en-GB', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          timeZone: 'Africa/Johannesburg',
        });

        const { buffer, filename } = await generateUnreturnedStockExcel({
          pickSlipRef: slip.id,
          storeName: slip.siteName,
          storeCode: slip.siteCode,
          clientName: slip.clientName,
          vendorNumber: slip.vendorNumber,
          repName: bookedRep ? `${bookedRep.name} ${bookedRep.surname}` : (slip.bookedRepName ?? '—'),
          grnDate: slip.receiptGrnDate || '—',
          captureDate,
          rows,
        });

        await sendUnreturnedStockEmail({
          to: toEmails,
          cc: ccEmails.length > 0 ? ccEmails : undefined,
          storeName: slip.siteName,
          storeCode: slip.siteCode,
          clientName: slip.clientName,
          vendorNumber: slip.vendorNumber,
          repName: bookedRep ? `${bookedRep.name} ${bookedRep.surname}` : (slip.bookedRepName ?? '—'),
          grnDate: slip.receiptGrnDate || '—',
          captureDate,
          totalUplifted,
          totalUpliftedVal,
          totalNotUplifted,
          unreturnedSummary: summary,
          pickSlipRef: slip.id,
          storeRef1: (slip.receiptStoreRefs ?? [])[0] || slip.receiptStoreRef1,
          attachment: { filename, content: buffer },
        });
        emailSent = true;
      }
    } catch (err) {
      console.error('[unreturned] Failed to send confirmation email:', err);
      emailError = err instanceof Error ? err.message : 'Failed to send email';
    }
  }

  return NextResponse.json(
    { ok: true, slip: updated, emailSent, emailError: emailError || undefined },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
