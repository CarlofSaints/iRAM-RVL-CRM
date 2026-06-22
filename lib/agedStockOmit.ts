import { loadControl } from '@/lib/controlData';
import type { ClientWithLinks, AgedStockOmit } from '@/lib/spLinkData';

/** Minimal site-control record shape needed for omission matching. */
interface SiteRec {
  siteNum: string;
  subChannel: string;
  country: string;
}

/**
 * A predicate that decides whether an aged-stock row's site should be OMITTED
 * for a client, based on the client's rules + the Site Control master. A site
 * is omitted when its country, sub-channel, or site number is on the client's
 * omit list. Site numbers are matched case-insensitively.
 */
export type OmitMatcher = (siteCode: string) => boolean;

/** Build an omission matcher for a client. Returns a no-op matcher (always false) when no rules. */
export async function buildOmitMatcher(omit: AgedStockOmit | undefined | null): Promise<OmitMatcher> {
  const countries = new Set((omit?.countries ?? []).map(s => s.trim().toUpperCase()).filter(Boolean));
  const subChannels = new Set((omit?.subChannels ?? []).map(s => s.trim().toUpperCase()).filter(Boolean));
  const siteNums = new Set((omit?.siteNums ?? []).map(s => s.trim().toUpperCase()).filter(Boolean));

  if (countries.size === 0 && subChannels.size === 0 && siteNums.size === 0) {
    return () => false;
  }

  // Only load the (potentially large) site master when rules exist.
  const sites = await loadControl<SiteRec>('sites');
  const byNum = new Map<string, SiteRec>();
  for (const s of sites) {
    const key = String(s.siteNum ?? '').trim().toUpperCase();
    if (key) byNum.set(key, s);
  }

  return (siteCode: string) => {
    const key = String(siteCode ?? '').trim().toUpperCase();
    if (!key) return false;
    if (siteNums.has(key)) return true;
    const rec = byNum.get(key);
    if (!rec) return false;
    if (countries.has(String(rec.country ?? '').trim().toUpperCase())) return true;
    if (subChannels.has(String(rec.subChannel ?? '').trim().toUpperCase())) return true;
    return false;
  };
}

/** Convenience: load a client's omit rules + build its matcher in one call. */
export async function buildClientOmitMatcher(clientId: string): Promise<OmitMatcher> {
  const clients = await loadControl<ClientWithLinks>('clients');
  const client = clients.find(c => c.id === clientId);
  return buildOmitMatcher(client?.agedStockOmit);
}
