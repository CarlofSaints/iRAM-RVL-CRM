/**
 * App-wide settings store (Vercel Blob).
 *
 * Blob key: `settings.json`
 *
 * Unlike control data (which is an array of records), settings is a
 * single JSON object. Each key group is a section (sticker, etc.).
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';

// ── Types ────────────────────────────────────────────────────────────────────

export type StickerLayout = 'roll' | 'a4sheet';

export interface StickerSettings {
  /** Sticker width in millimetres */
  widthMm: number;
  /** Sticker height in millimetres */
  heightMm: number;
  /** Layout mode: 'roll' = one sticker per page (page = sticker size), 'a4sheet' = grid on A4 */
  layout: StickerLayout;
}

export interface AppSettings {
  sticker: StickerSettings;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_STICKER: StickerSettings = {
  widthMm: 74,
  heightMm: 50,
  layout: 'roll',
};

export const DEFAULT_SETTINGS: AppSettings = {
  sticker: DEFAULT_STICKER,
};

// ── Blob / local helpers ─────────────────────────────────────────────────────

const BLOB_KEY = 'settings.json';
const LOCAL_PATH = path.join(process.cwd(), 'data', 'settings.json');

export async function loadSettings(): Promise<AppSettings> {
  if (!process.env.VERCEL) {
    try {
      if (fs.existsSync(LOCAL_PATH)) {
        const raw = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
        return { ...DEFAULT_SETTINGS, ...raw };
      }
    } catch { /* empty */ }
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const result = await get(BLOB_KEY, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      const raw = JSON.parse(text);
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch (err) {
    console.error('[settingsData] Blob read failed:', err instanceof Error ? err.message : err);
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const json = JSON.stringify(settings, null, 2);

  try {
    await put(BLOB_KEY, json, {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist settings to Vercel Blob: ${msg}`);
  }

  // Local dev: also write to disk
  try {
    const dir = path.dirname(LOCAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_PATH, json);
  } catch {
    // Vercel read-only FS — expected
  }
}
