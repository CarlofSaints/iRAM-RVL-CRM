/**
 * Site codes come from the retailer, so two channels can share one (Dis-Chem
 * S148 and Massbuild S148). A store is unique by channel + code, not code alone.
 */
export interface StoreLike {
  siteCode?: string;
  name?: string;
  channel?: string;
}

const norm = (v: unknown) => String(v ?? '').trim().toUpperCase();

/** Upload dedup key: channel + code. */
export function storeKey(s: StoreLike): string {
  return `${norm(s.channel)}|${norm(s.siteCode)}`;
}

/**
 * Find the store for a site code. When the code is shared across channels,
 * prefer the given channel, then the store whose name matches the file's site
 * name (exact, else most words in common, e.g. "BEX ..." vs "DIS-CHEM ...").
 */
export function findStoreByCode<T extends StoreLike>(
  stores: T[],
  siteCode: string | undefined,
  hint: { siteName?: string; channel?: string } = {},
): T | undefined {
  const code = norm(siteCode);
  if (!code) return undefined;
  const hits = stores.filter(s => norm(s.siteCode) === code);
  if (hits.length <= 1) return hits[0];

  const channel = norm(hint.channel);
  if (channel) {
    const byChannel = hits.filter(s => norm(s.channel) === channel);
    if (byChannel.length) return byChannel[0];
  }

  const name = norm(hint.siteName);
  if (!name) return hits[0];
  const exact = hits.find(s => norm(s.name) === name);
  if (exact) return exact;
  const words = new Set(name.split(/[\s\-_]+/).filter(Boolean));
  let best = hits[0];
  let bestScore = -1;
  for (const s of hits) {
    const score = norm(s.name).split(/[\s\-_]+/).filter(w => words.has(w)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}
