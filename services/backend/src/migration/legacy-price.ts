export type LegacyListedPrice =
  | { classification: 'priced'; cents: number; label: string }
  | { classification: 'unpriced' | 'unresolved'; cents: null; label: string | null };

const maximumCents = 2_147_483_647;
const amount = '(\\d{1,8})(?:\\.(\\d{1,2}))?';
const space = '[^\\S\\r\\n]*';
const perPerson = `(?:${space}/${space}人)?`;
// These whole-label forms were audited in the legacy US ride data. Bare numbers
// retain the existing USD convention; “刀” is only accepted in this migration
// context. Other currencies, conditions and unspecified currency + /人 do not match.
const pricedForms = [
  new RegExp(`^${amount}$`),
  new RegExp(`^\\$${space}${amount}${perPerson}$`),
  new RegExp(`^${amount}${space}(?:\\$|USD|美元|美金|刀)${perPerson}$`, 'i'),
];
// No-digit text means no parseable quote, not agreement to negotiate or travel
// for free. Non-ASCII numeric notation must not fall into that category.
const numericNotation = /[\p{N}零〇一二两兩三四五六七八九十百千万萬亿億兆壹贰貳叁參肆伍陆陸柒捌玖拾佰仟点點半]/u;

/**
 * Confirm only an exact scalar USD listed quote, never a transaction price.
 * The unit is not inferred: a label without /人 does not establish per-person
 * pricing. Keep label for historical display instead of appending a unit.
 *
 * String labels are preserved byte-for-byte at the JS string level, including
 * whitespace. Numeric scalar labels use String(value); null/undefined or an
 * unsupported non-scalar have label=null. Results can contain private free text:
 * callers must not log them; audit reports should count classifications only.
 */
export function parseLegacyListedPrice(value: unknown): LegacyListedPrice {
  if (value === null || value === undefined) return { classification: 'unpriced', cents: null, label: null };
  if (typeof value !== 'string' && typeof value !== 'number') return { classification: 'unresolved', cents: null, label: null };
  const label = String(value);
  if (typeof value === 'number' && !Number.isFinite(value)) return { classification: 'unresolved', cents: null, label };
  const text = label.trim();
  if (!text) return { classification: 'unpriced', cents: null, label };
  if (text === '免费' || /^free$/i.test(text)) return { classification: 'priced', cents: 0, label };

  for (const form of pricedForms) {
    const match = form.exec(text);
    if (!match) continue;
    // Both pieces are bounded digit strings. Do not multiply a decimal float
    // or round away unsupported precision.
    const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return cents <= maximumCents
      ? { classification: 'priced', cents, label }
      : { classification: 'unresolved', cents: null, label };
  }
  return { classification: numericNotation.test(text) ? 'unresolved' : 'unpriced', cents: null, label };
}
