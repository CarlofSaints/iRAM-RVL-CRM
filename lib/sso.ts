import crypto from 'crypto';

export interface SSOPayload {
  sub: string;       // user ID on Hub
  email: string;
  name: string;
  surname: string;
  hubRole: 'super-admin' | 'user';
  modules: string[]; // module slugs the user has access to
  iat: number;       // issued at (epoch seconds)
  exp: number;       // expires at (epoch seconds)
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

/**
 * Verify a signed SSO token from the Hub.
 * Returns the payload or null if invalid/expired.
 */
export function verifySSOToken(token: string, secret: string): SSOPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;

  // Verify signature
  const expected = base64url(
    crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest(),
  );

  if (sig.length !== expected.length) return null;
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  // Decode payload
  try {
    const payload = JSON.parse(base64urlDecode(body)) as SSOPayload;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Build the Hub login URL for SSO redirect (Flow B).
 */
export function getSSOLoginUrl(hubUrl: string, callbackUrl: string, moduleSlug: string): string {
  const params = new URLSearchParams({ redirect: callbackUrl, module: moduleSlug });
  return `${hubUrl}/login?${params.toString()}`;
}
