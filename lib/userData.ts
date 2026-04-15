import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import { Role } from './roles';

export interface User {
  id: string;
  name: string;
  surname: string;
  email: string;
  password: string;
  role: Role;
  forcePasswordChange: boolean;
  firstLoginAt: string | null;
  createdAt: string;
}

const BLOB_KEY = 'users.json';

/**
 * Load users from Vercel Blob (production) or local file (dev).
 * NO module-level cache — multi-container serverless safety.
 */
export async function loadUsers(): Promise<User[]> {
  if (!process.env.VERCEL) {
    const localFile = path.join(process.cwd(), 'data', 'users.json');
    try {
      if (fs.existsSync(localFile)) {
        return JSON.parse(fs.readFileSync(localFile, 'utf-8')) as User[];
      }
    } catch { /* empty */ }
    return [];
  }

  try {
    const result = await get(BLOB_KEY, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return JSON.parse(text) as User[];
    }
  } catch (err) {
    console.error('[userData] Blob read failed:', err instanceof Error ? err.message : err);
  }
  return [];
}

export async function saveUsers(users: User[]): Promise<void> {
  const json = JSON.stringify(users, null, 2);

  try {
    await put(BLOB_KEY, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist users to Vercel Blob: ${msg}`);
  }

  // Local dev: also write to local file
  try {
    const localFile = path.join(process.cwd(), 'data', 'users.json');
    const dir = path.dirname(localFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localFile, json);
  } catch {
    // Vercel read-only FS — expected
  }
}
