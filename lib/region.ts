/**
 * Store region → province name.
 *
 * `region` lives on the store control record (Control Centre → Stores) as a
 * free-text code someone types in, so the same province can arrive under more
 * than one spelling. Live data on 18 Aug 2026 (719 stores) held:
 *   GAU 271 · WC 155 · KZN 87 · EC 60 · LIM 48 · MPU 34 · NW 33 · FS 21 ·
 *   NC 6 · MP 4
 * — i.e. Mpumalanga under BOTH `MPU` and `MP`. Canonicalising here means a
 * region filter offers one "Mpumalanga" rather than two half-lists.
 *
 * Anything unrecognised is passed straight back, so a region nobody has
 * mapped yet still shows in the grid and still gets its own filter option
 * instead of silently vanishing.
 */
const PROVINCE_BY_CODE: Record<string, string> = {
  GAU: 'Gauteng',
  GP: 'Gauteng',
  GAUTENG: 'Gauteng',
  WC: 'Western Cape',
  WESTERNCAPE: 'Western Cape',
  EC: 'Eastern Cape',
  EASTERNCAPE: 'Eastern Cape',
  NC: 'Northern Cape',
  NORTHERNCAPE: 'Northern Cape',
  KZN: 'KwaZulu-Natal',
  KWAZULUNATAL: 'KwaZulu-Natal',
  FS: 'Free State',
  FREESTATE: 'Free State',
  NW: 'North West',
  NORTHWEST: 'North West',
  MP: 'Mpumalanga',
  MPU: 'Mpumalanga',
  MPUMALANGA: 'Mpumalanga',
  LIM: 'Limpopo',
  LP: 'Limpopo',
  LIMPOPO: 'Limpopo',
};

/** Canonical province name for a store's region code. '' when there is none. */
export function provinceName(region: string | null | undefined): string {
  const raw = (region ?? '').trim();
  if (!raw) return '';
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');
  return PROVINCE_BY_CODE[key] ?? raw;
}
