import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { loadUsers, saveUsers } from '@/lib/userData';

export const dynamic = 'force-dynamic';

/** PayFast sandbox + production IP ranges for ITN validation. */
const PAYFAST_IPS = [
  '197.97.145.144/28',
  '41.74.179.192/27',
  '197.97.145.128/27',
];

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits)) - 1);
  const ipNum = ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0);
  const rangeNum = range.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0);
  return (ipNum & mask) === (rangeNum & mask);
}

function isPayfastIp(ip: string): boolean {
  return PAYFAST_IPS.some(cidr => ipInCidr(ip, cidr));
}

function generateSignature(data: Record<string, string>, passphrase?: string): string {
  const params = Object.entries(data)
    .filter(([k, v]) => k !== 'signature' && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
    .join('&');
  const withPass = passphrase ? `${params}&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}` : params;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    // 1. Parse form body
    const body = await req.text();
    const params = new URLSearchParams(body);
    const data: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      data[k] = v;
    }

    // 2. IP validation (skip in sandbox/dev for flexibility)
    const sandbox = process.env.PAYFAST_SANDBOX === 'true';
    if (!sandbox) {
      const forwarded = req.headers.get('x-forwarded-for');
      const ip = forwarded ? forwarded.split(',')[0].trim() : '';
      if (ip && !isPayfastIp(ip)) {
        console.warn('[PayFast ITN] Rejected — IP not in whitelist:', ip);
        return new NextResponse('Invalid source IP', { status: 403 });
      }
    }

    // 3. Signature validation
    const passphrase = process.env.PAYFAST_PASSPHRASE || undefined;
    const expectedSig = generateSignature(data, passphrase);
    if (data.signature && data.signature !== expectedSig) {
      console.warn('[PayFast ITN] Signature mismatch');
      return new NextResponse('Invalid signature', { status: 400 });
    }

    // 4. Amount validation
    if (data.amount !== '189.00') {
      console.warn('[PayFast ITN] Amount mismatch:', data.amount);
      return new NextResponse('Amount mismatch', { status: 400 });
    }

    // 5. Process based on payment_status
    const userId = data.custom_str1;
    const status = data.payment_status;

    if (!userId) {
      console.warn('[PayFast ITN] Missing custom_str1 (userId)');
      return new NextResponse('Missing user ID', { status: 400 });
    }

    const users = await loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
      console.warn('[PayFast ITN] User not found:', userId);
      return new NextResponse('User not found', { status: 404 });
    }

    if (status === 'COMPLETE') {
      // Upgrade to Pro
      user.subscription = {
        ...(user.subscription ?? { tier: 'standard' }),
        tier: 'pro',
        upgradedAt: new Date().toISOString(),
        payfastToken: data.token || undefined,
        payfastSubscriptionId: data.m_payment_id || undefined,
      };
      await saveUsers(users);
      console.log('[PayFast ITN] User upgraded to Pro:', userId);
    } else if (status === 'CANCELLED') {
      // Downgrade to Standard
      if (user.subscription) {
        user.subscription.tier = 'standard';
        user.subscription.payfastToken = undefined;
        user.subscription.payfastSubscriptionId = undefined;
      }
      await saveUsers(users);
      console.log('[PayFast ITN] Subscription cancelled, downgraded:', userId);
    } else {
      console.log('[PayFast ITN] Status:', status, 'for user:', userId);
    }

    return new NextResponse('OK', { status: 200 });
  } catch (err) {
    console.error('[PayFast ITN] Error:', err instanceof Error ? err.message : err);
    return new NextResponse('Internal error', { status: 500 });
  }
}
