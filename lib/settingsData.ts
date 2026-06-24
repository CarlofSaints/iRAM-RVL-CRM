/**
 * App-wide settings store (Vercel Blob).
 *
 * Blob key: `settings.json`
 *
 * Unlike control data (which is an array of records), settings is a
 * single JSON object. Each key group is a section (sticker, etc.).
 *
 * Stickers support TWO independent profiles — `roll` (thermal/roll printers,
 * e.g. Postek) and `a4sheet` (A4 sheet labels, e.g. 99.1 x 139 mm 4-up) —
 * so both can be configured and printed without re-calibrating each time.
 * The format is chosen at print time; `defaultLayout` is used when a caller
 * doesn't specify one.
 */

import fs from 'fs';
import path from 'path';
import { put, get } from '@vercel/blob';

// ── Types ────────────────────────────────────────────────────────────────────

export type StickerLayout = 'roll' | 'a4sheet';

export interface StickerProfile {
  /** Sticker width in millimetres */
  widthMm: number;
  /** Sticker height in millimetres */
  heightMm: number;
  /**
   * Gap between labels in mm.
   * - roll: inter-label gap added to page height so pages match the roll pitch.
   * - a4sheet: gap between cells in the grid (0 = contiguous, e.g. pre-cut 4-up).
   */
  gapMm: number;
  /** Content margins in millimetres (fine-tune print alignment) */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface StickerSettings {
  /** Profile used when a print request doesn't specify a format. */
  defaultLayout: StickerLayout;
  roll: StickerProfile;
  a4sheet: StickerProfile;
}

export interface AppSettings {
  sticker: StickerSettings;
  /**
   * Reasons an admin can pick from when marking a sent pick slip "Unsuccessful"
   * (e.g. upliftment couldn't be completed at the store). Editable in the
   * Control Centre → Upliftment Reasons page.
   */
  upliftFailureReasons: string[];
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_ROLL_PROFILE: StickerProfile = {
  widthMm: 74,
  heightMm: 50,
  gapMm: 0,
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
};

export const DEFAULT_A4_PROFILE: StickerProfile = {
  // A4 4-up shipping labels (Avery L7169 / J8169 geometry).
  // gap 0 → labels are contiguous; the A4 grid auto-centres to ~5.9mm L/R + ~9.5mm T/B margins.
  widthMm: 99.1,
  heightMm: 139,
  gapMm: 0,
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
};

export const DEFAULT_STICKER: StickerSettings = {
  defaultLayout: 'a4sheet',
  roll: { ...DEFAULT_ROLL_PROFILE },
  a4sheet: { ...DEFAULT_A4_PROFILE },
};

export const DEFAULT_UPLIFT_FAILURE_REASONS: string[] = [
  'Personnel not available',
  'Wrong Rep Allocated',
];

export const DEFAULT_SETTINGS: AppSettings = {
  sticker: DEFAULT_STICKER,
  upliftFailureReasons: [...DEFAULT_UPLIFT_FAILURE_REASONS],
};

/** Coerce raw uplift-failure reasons into a clean, deduped, non-empty string list. */
export function normalizeUpliftFailureReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_UPLIFT_FAILURE_REASONS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const t = r.trim();
    if (!t) continue;
    const lc = t.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(t);
  }
  return out;
}

// ── Normalisation / migration ────────────────────────────────────────────────

/** Coerce a partial profile into a complete one, filling gaps from `fallback`. */
function coerceProfile(p: unknown, fallback: StickerProfile): StickerProfile {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && !isNaN(v) ? v : d);
  return {
    widthMm: num(o.widthMm, fallback.widthMm),
    heightMm: num(o.heightMm, fallback.heightMm),
    gapMm: num(o.gapMm, fallback.gapMm),
    marginTop: num(o.marginTop, fallback.marginTop),
    marginBottom: num(o.marginBottom, fallback.marginBottom),
    marginLeft: num(o.marginLeft, fallback.marginLeft),
    marginRight: num(o.marginRight, fallback.marginRight),
  };
}

/**
 * Normalise raw blob/disk JSON into the current AppSettings shape.
 * Handles three cases:
 *   1. Already new shape (`roll`/`a4sheet` present) → coerce each profile.
 *   2. Legacy flat shape (`layout` + `widthMm` at sticker level) → migrate the
 *      flat values into the matching profile, default the other.
 *   3. Missing/garbage → full defaults.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const reasons = normalizeUpliftFailureReasons(root.upliftFailureReasons);
  const s = root.sticker as Record<string, unknown> | undefined;

  if (!s || typeof s !== 'object') {
    return {
      sticker: { defaultLayout: 'a4sheet', roll: { ...DEFAULT_ROLL_PROFILE }, a4sheet: { ...DEFAULT_A4_PROFILE } },
      upliftFailureReasons: reasons,
    };
  }

  // Case 1: new shape
  if ('roll' in s || 'a4sheet' in s) {
    const dl = s.defaultLayout === 'roll' || s.defaultLayout === 'a4sheet' ? s.defaultLayout : DEFAULT_STICKER.defaultLayout;
    return {
      sticker: {
        defaultLayout: dl,
        roll: coerceProfile(s.roll, DEFAULT_ROLL_PROFILE),
        a4sheet: coerceProfile(s.a4sheet, DEFAULT_A4_PROFILE),
      },
      upliftFailureReasons: reasons,
    };
  }

  // Case 2: legacy flat shape — migrate into the matching profile
  const oldLayout: StickerLayout = s.layout === 'a4sheet' ? 'a4sheet' : 'roll';
  const flat = coerceProfile(s, oldLayout === 'roll' ? DEFAULT_ROLL_PROFILE : DEFAULT_A4_PROFILE);
  return {
    sticker: {
      defaultLayout: oldLayout,
      roll: oldLayout === 'roll' ? flat : { ...DEFAULT_ROLL_PROFILE },
      a4sheet: oldLayout === 'a4sheet' ? flat : { ...DEFAULT_A4_PROFILE },
    },
    upliftFailureReasons: reasons,
  };
}

/** Resolve the effective layout for a print, honouring an optional request. */
export function resolveLayout(settings: AppSettings, requested?: string | null): StickerLayout {
  return requested === 'roll' || requested === 'a4sheet' ? requested : settings.sticker.defaultLayout;
}

/** Get the profile for a given layout. */
export function profileFor(settings: AppSettings, layout: StickerLayout): StickerProfile {
  return layout === 'a4sheet' ? settings.sticker.a4sheet : settings.sticker.roll;
}

// ── Blob / local helpers ─────────────────────────────────────────────────────

const BLOB_KEY = 'settings.json';
const LOCAL_PATH = path.join(process.cwd(), 'data', 'settings.json');

export async function loadSettings(): Promise<AppSettings> {
  if (!process.env.VERCEL) {
    try {
      if (fs.existsSync(LOCAL_PATH)) {
        const raw = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
        return normalizeSettings(raw);
      }
    } catch { /* empty */ }
    return normalizeSettings(null);
  }

  try {
    const result = await get(BLOB_KEY, { access: 'private', useCache: false });
    if (result && result.statusCode === 200) {
      const text = await new Response(result.stream).text();
      return normalizeSettings(JSON.parse(text));
    }
  } catch (err) {
    console.error('[settingsData] Blob read failed:', err instanceof Error ? err.message : err);
  }
  return normalizeSettings(null);
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
