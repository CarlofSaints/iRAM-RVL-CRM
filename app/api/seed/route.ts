import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { loadUsers, saveUsers, User } from '@/lib/userData';
import { loadControl, saveControl, ControlType } from '@/lib/controlData';

export const dynamic = 'force-dynamic';

interface Warehouse {
  id: string;
  name: string;
  code: string;
  region: string;
  createdAt: string;
}

export async function POST(req: NextRequest) {
  const { secret } = await req.json();
  if (secret !== process.env.SEED_SECRET && secret !== 'rvl-seed-2026') {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 403 });
  }

  const users = await loadUsers();

  const seedUsers: Array<{ name: string; surname: string; email: string; password: string }> = [
    { name: 'Carl', surname: 'Dos Santos', email: 'carl@outerjoin.co.za', password: 'rvl2026' },
    { name: 'Johann', surname: '', email: 'johann@iram.co.za', password: 'rvl2026' },
  ];

  let added = 0;
  for (const su of seedUsers) {
    if (users.find(u => u.email.toLowerCase() === su.email.toLowerCase())) continue;
    const user: User = {
      id: randomUUID(),
      name: su.name,
      surname: su.surname,
      email: su.email,
      password: await bcrypt.hash(su.password, 10),
      role: 'super-user',
      forcePasswordChange: true,
      firstLoginAt: null,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    added++;
  }

  if (added > 0) await saveUsers(users);

  // Seed warehouses
  const warehouses = await loadControl<Warehouse>('warehouses' as ControlType);
  const seedWarehouses = [
    { name: 'Gauteng', code: 'GAU', region: 'Gauteng' },
    { name: 'KwaZulu-Natal', code: 'KZN', region: 'KwaZulu-Natal' },
    { name: 'Western Cape', code: 'WC', region: 'Western Cape' },
    { name: 'Port Elizabeth', code: 'PE', region: 'Eastern Cape' },
  ];

  let warehousesAdded = 0;
  for (const sw of seedWarehouses) {
    if (warehouses.find(w => w.code === sw.code)) continue;
    warehouses.push({
      id: randomUUID(),
      name: sw.name,
      code: sw.code,
      region: sw.region,
      createdAt: new Date().toISOString(),
    });
    warehousesAdded++;
  }
  if (warehousesAdded > 0) await saveControl('warehouses' as ControlType, warehouses);

  return NextResponse.json({
    ok: true,
    usersAdded: added,
    warehousesAdded,
    totalUsers: users.length,
    totalWarehouses: warehouses.length,
  });
}
