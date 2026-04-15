import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { loadControl, saveControl, ControlType } from '@/lib/controlData';

export const dynamic = 'force-dynamic';

const VALID_TYPES: ControlType[] = ['clients', 'stores', 'products', 'reps', 'warehouses'];

function isValidType(type: string): type is ControlType {
  return VALID_TYPES.includes(type as ControlType);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isValidType(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  const items = await loadControl(type);
  return NextResponse.json(items, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isValidType(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  const body = await req.json();

  // Handle bulk import (array of items)
  if (Array.isArray(body)) {
    const items = await loadControl<Record<string, unknown>>(type);
    let added = 0;
    for (const record of body) {
      items.push({
        ...record,
        id: record.id || randomUUID(),
        createdAt: record.createdAt || new Date().toISOString(),
      });
      added++;
    }
    await saveControl(type, items);
    return NextResponse.json({ ok: true, added, total: items.length }, { status: 201 });
  }

  // Single item
  const items = await loadControl<Record<string, unknown>>(type);
  const item = {
    ...body,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  await saveControl(type, items);
  return NextResponse.json(item, { status: 201 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isValidType(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  const body = await req.json();
  const { id, ...updates } = body;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const items = await loadControl<Record<string, unknown>>(type);
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  items[idx] = { ...items[idx], ...updates };
  await saveControl(type, items);
  return NextResponse.json(items[idx]);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isValidType(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const items = await loadControl<Record<string, unknown>>(type);
  const filtered = items.filter(i => i.id !== id);
  if (filtered.length === items.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await saveControl(type, filtered);
  return NextResponse.json({ ok: true });
}
