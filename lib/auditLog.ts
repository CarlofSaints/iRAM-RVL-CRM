/**
 * Audit log — append-only activity tracking.
 *
 * Blob key: `auditLog/{YYYY-MM}.json`
 * Each month gets its own file to keep individual files manageable.
 * No module-level cache — multi-container serverless safety.
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';
import { randomUUID } from 'crypto';

export interface AuditEntry {
  id: string;
  action: string;
  userId: string;
  userName: string;
  slipId?: string;
  clientId?: string;
  detail: string;
  timestamp: string;
}

function monthKey(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `auditLog/${yyyy}-${mm}.json`;
}

function localPath(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return path.join(process.cwd(), 'data', 'auditLog', `${yyyy}-${mm}.json`);
}

async function loadEntries(key: string): Promise<AuditEntry[]> {
  if (process.env.VERCEL) {
    try {
      const result = await get(key, { access: 'private', useCache: false });
      if (result && result.statusCode === 200) {
        const text = await new Response(result.stream).text();
        return JSON.parse(text) as AuditEntry[];
      }
    } catch { /* not found or error — return empty */ }
    return [];
  }
  // Local dev
  try {
    const fp = localPath();
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as AuditEntry[];
    }
  } catch { /* empty */ }
  return [];
}

async function saveEntries(key: string, entries: AuditEntry[]): Promise<void> {
  const json = JSON.stringify(entries, null, 2);
  if (process.env.VERCEL) {
    await put(key, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    return;
  }
  // Local dev
  try {
    const fp = localPath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, json);
  } catch { /* Vercel read-only FS — expected */ }
}

/**
 * Append an audit entry for the current month.
 */
export async function logAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
  const key = monthKey();
  const entries = await loadEntries(key);
  entries.push({
    ...entry,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  });
  await saveEntries(key, entries);
}

/**
 * Load audit entries for a given month (YYYY-MM string).
 */
export async function getAuditEntries(month: string): Promise<AuditEntry[]> {
  const key = `auditLog/${month}.json`;
  return loadEntries(key);
}

/**
 * List available audit log months by scanning known keys.
 * Since Blob doesn't have a list-by-prefix that's efficient for private stores,
 * we return the last 12 months as potential candidates.
 */
export function getRecentMonths(): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    months.push(`${yyyy}-${mm}`);
  }
  return months;
}
