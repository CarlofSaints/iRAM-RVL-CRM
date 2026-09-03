import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { promoContext, fullName } from '@/lib/promoScope';
import { loadUsers } from '@/lib/userData';
import { loadControl } from '@/lib/controlData';
import { loadRoles } from '@/lib/rolesData';
import { listPromoContacts, savePromoContacts, type PromoContact, type PromoHolder } from '@/lib/promoData';
import { logAudit } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';

interface Rep {
  id: string;
  name: string;
  surname: string;
  email: string;
  region?: string;
}

/**
 * GET /api/promo/holders — everyone who can be picked as "the person taking the kit".
 *
 * Three sources in one searchable list: app users, the reps masterfile, and the
 * promo contacts created from this screen. Whoever takes a kit does NOT need to
 * be a loaded rep or RVL manager — see POST below.
 */
export async function GET(req: NextRequest) {
  const ctx = await promoContext(req, 'view_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const [users, reps, contacts, roles] = await Promise.all([
    loadUsers(),
    loadControl<Rep>('reps'),
    listPromoContacts(),
    loadRoles(),
  ]);
  const roleName = new Map(roles.map(r => [r.id, r.name] as const));

  const holders: Array<PromoHolder & { subtitle?: string }> = [];

  for (const u of users) {
    if (!u.email) continue;
    holders.push({
      type: 'user',
      id: u.id,
      name: fullName(u) || u.email,
      email: u.email,
      subtitle: roleName.get(u.role) ?? u.role,
    });
  }

  const userEmails = new Set(users.map(u => (u.email || '').toLowerCase()).filter(Boolean));
  for (const r of reps) {
    const email = (r.email || '').trim();
    if (!email || userEmails.has(email.toLowerCase())) continue; // already listed as a user
    holders.push({
      type: 'rep',
      id: r.id,
      name: [r.name, r.surname].filter(Boolean).join(' ').trim() || email,
      email,
      subtitle: r.region ? `Rep - ${r.region}` : 'Rep',
    });
  }

  for (const c of contacts) {
    holders.push({
      type: 'contact',
      id: c.id,
      name: c.name,
      email: c.email,
      subtitle: 'Promo contact',
    });
  }

  holders.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ holders }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/promo/holders — create a promo contact for someone who is not in the list.
 *
 * Deliberately NOT a login. They get the booked-out and returned emails and
 * appear in the picker next time; they cannot sign in, so there is no password
 * to leak and no extra surface on the app. Body: { name, email, phone? }
 */
export async function POST(req: NextRequest) {
  const ctx = await promoContext(req, 'book_promo_kits');
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => null) as
    | { name?: string; email?: string; phone?: string }
    | null;
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const name = (body.name ?? '').trim();
  const email = (body.email ?? '').trim();
  if (!email) return NextResponse.json({ error: 'An email address is required' }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: `"${email}" does not look like an email address` }, { status: 400 });
  }

  const contacts = await listPromoContacts();
  const existing = contacts.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (existing) return NextResponse.json({ contact: existing, existed: true });

  const contact: PromoContact = {
    id: randomUUID(),
    name: name || email.split('@')[0],
    email,
    phone: (body.phone ?? '').trim() || undefined,
    createdAt: new Date().toISOString(),
    createdByName: fullName(ctx.me),
  };
  contacts.push(contact);
  await savePromoContacts(contacts);

  await logAudit({
    action: 'promo-contact-create',
    userId: ctx.me.id,
    userName: fullName(ctx.me),
    detail: `Promo contact created: ${contact.name} (${contact.email})`,
  });

  return NextResponse.json({ contact, existed: false });
}
