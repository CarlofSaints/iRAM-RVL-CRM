import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requirePermission } from '@/lib/rolesData';
import { loadControl, saveControl } from '@/lib/controlData';
import type { ClientWithLinks, ClientContact } from '@/lib/spLinkData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/clients/[id]/contacts
 * Returns contacts for a client.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const clients = await loadControl<ClientWithLinks>('clients');
  const client = clients.find(c => c.id === id);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  return NextResponse.json(client.contacts ?? [], { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/clients/[id]/contacts
 * Add a new contact.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const name = (body.name ?? '').toString().trim();
  const surname = (body.surname ?? '').toString().trim();
  const email = (body.email ?? '').toString().trim();
  const role = (body.role ?? '').toString().trim();
  const receiveDeliveryNotes = !!body.receiveDeliveryNotes;

  if (!name || !email) {
    return NextResponse.json({ error: 'Name and email are required' }, { status: 400 });
  }

  const clients = await loadControl<ClientWithLinks>('clients');
  const idx = clients.findIndex(c => c.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  if (!clients[idx].contacts) clients[idx].contacts = [];

  const contact: ClientContact = {
    id: randomUUID(),
    name,
    surname,
    email,
    role,
    receiveDeliveryNotes,
  };

  clients[idx].contacts!.push(contact);
  await saveControl('clients', clients);

  return NextResponse.json(contact, { status: 201 });
}

/**
 * PATCH /api/clients/[id]/contacts
 * Update a contact (pass contactId in body).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const contactId = body.contactId as string;
  if (!contactId) return NextResponse.json({ error: 'contactId is required' }, { status: 400 });

  const clients = await loadControl<ClientWithLinks>('clients');
  const clientIdx = clients.findIndex(c => c.id === id);
  if (clientIdx === -1) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const contacts = clients[clientIdx].contacts ?? [];
  const contactIdx = contacts.findIndex(c => c.id === contactId);
  if (contactIdx === -1) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

  if (body.name !== undefined) contacts[contactIdx].name = String(body.name).trim();
  if (body.surname !== undefined) contacts[contactIdx].surname = String(body.surname).trim();
  if (body.email !== undefined) contacts[contactIdx].email = String(body.email).trim();
  if (body.role !== undefined) contacts[contactIdx].role = String(body.role).trim();
  if (body.receiveDeliveryNotes !== undefined) contacts[contactIdx].receiveDeliveryNotes = !!body.receiveDeliveryNotes;

  clients[clientIdx].contacts = contacts;
  await saveControl('clients', clients);

  return NextResponse.json(contacts[contactIdx]);
}

/**
 * DELETE /api/clients/[id]/contacts
 * Delete a contact (pass contactId in body).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requirePermission(req, 'manage_clients');
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  const contactId = body.contactId as string;
  if (!contactId) return NextResponse.json({ error: 'contactId is required' }, { status: 400 });

  const clients = await loadControl<ClientWithLinks>('clients');
  const clientIdx = clients.findIndex(c => c.id === id);
  if (clientIdx === -1) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const before = (clients[clientIdx].contacts ?? []).length;
  clients[clientIdx].contacts = (clients[clientIdx].contacts ?? []).filter(c => c.id !== contactId);

  if (clients[clientIdx].contacts!.length === before) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  await saveControl('clients', clients);
  return NextResponse.json({ ok: true });
}
