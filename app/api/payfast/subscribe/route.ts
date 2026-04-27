import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireLogin } from '@/lib/rolesData';
import { loadUsers } from '@/lib/userData';

export const dynamic = 'force-dynamic';

const AMOUNT = '189.00'; // R189 per month

function generateSignature(data: Record<string, string>, passphrase?: string): string {
  const params = Object.entries(data)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
    .join('&');
  const withPass = passphrase ? `${params}&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}` : params;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

export async function POST(req: NextRequest) {
  const guard = await requireLogin(req);
  if (guard instanceof NextResponse) return guard;

  const { PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE, PAYFAST_SANDBOX, NEXT_PUBLIC_SITE_URL } = process.env;

  if (!PAYFAST_MERCHANT_ID || !PAYFAST_MERCHANT_KEY) {
    return NextResponse.json({ error: 'PayFast not configured' }, { status: 500 });
  }

  const users = await loadUsers();
  const user = users.find(u => u.id === guard.userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (user.subscription?.tier === 'pro') {
    return NextResponse.json({ error: 'Already on Pro plan' }, { status: 400 });
  }

  const siteUrl = NEXT_PUBLIC_SITE_URL || 'https://iram-rvl-crm.vercel.app';
  const sandbox = PAYFAST_SANDBOX === 'true';
  const payfastUrl = sandbox
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';

  const paymentId = `rvl-pro-${user.id.slice(0, 8)}-${Date.now()}`;

  // Build the data object in PayFast's required order
  const data: Record<string, string> = {
    merchant_id: PAYFAST_MERCHANT_ID,
    merchant_key: PAYFAST_MERCHANT_KEY,
    return_url: `${siteUrl}/account?tab=billing&upgraded=1`,
    cancel_url: `${siteUrl}/account?tab=billing`,
    notify_url: `${siteUrl}/api/payfast/notify`,
    name_first: user.name,
    name_last: user.surname || '',
    email_address: user.email,
    m_payment_id: paymentId,
    amount: AMOUNT,
    item_name: 'iRamFlow Pro Subscription',
    item_description: 'Monthly Pro subscription for iRamFlow CRM',
    custom_str1: user.id,
    subscription_type: '1',
    billing_date: new Date().toISOString().slice(0, 10),
    recurring_amount: AMOUNT,
    frequency: '3', // monthly
    cycles: '0', // indefinite
  };

  const signature = generateSignature(data, PAYFAST_PASSPHRASE || undefined);
  data.signature = signature;

  return NextResponse.json({
    payfastUrl,
    formData: data,
  });
}
