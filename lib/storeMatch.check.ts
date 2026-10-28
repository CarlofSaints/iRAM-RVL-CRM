// Self-check: npx tsx lib/storeMatch.check.ts
import assert from 'node:assert';
import { findStoreByCode, storeKey } from './storeMatch';

const stores = [
  { siteCode: 'S148', name: 'BEX CHERRY LANE', channel: 'MASSBUILD' },
  { siteCode: 'S148', name: 'DIS-CHEM AMBERFIELD', channel: 'Dis-Chem' },
  { siteCode: 'S074', name: 'DIS-CHEM ALBEMARLE GARDENS', channel: 'Dis-Chem' },
];
assert.equal(findStoreByCode(stores, 's074 ')?.name, 'DIS-CHEM ALBEMARLE GARDENS');
assert.equal(findStoreByCode(stores, 'S148', { channel: 'dis-chem' })?.name, 'DIS-CHEM AMBERFIELD');
assert.equal(findStoreByCode(stores, 'S148', { siteName: 'Dis-Chem Amberfield' })?.name, 'DIS-CHEM AMBERFIELD');
assert.equal(findStoreByCode(stores, 'S148', { siteName: 'BEX Cherry Lane_S148' })?.name, 'BEX CHERRY LANE');
assert.equal(findStoreByCode(stores, 'S999'), undefined);
assert.notEqual(storeKey(stores[0]), storeKey(stores[1]));
console.log('storeMatch ok');
