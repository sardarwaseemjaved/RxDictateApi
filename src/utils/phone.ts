/**
 * A phone number, or the start of one, as somebody typed it into a search, in
 * the E.164 form every phone is stored in, so it can be matched from the
 * start. Pakistani numbers are the ones typed locally:
 *
 * - `0300 1234567` and `0300-1234567` → `+923001234567`
 * - `923001234567` and `00923001234567` → `+923001234567`
 * - `3001234567` → `+923001234567`
 * - `+44 20…` stays as it is, without the spaces.
 *
 * Null when it is not a phone at all: anything but digits, spaces, dashes,
 * brackets and one leading +.
 */
export const typedPhoneToE164 = (typed: string): string | null => {
  const compact = typed.replace(/[\s\-()]/g, '');
  if (!/^\+?\d+$/.test(compact)) {
    return null;
  }
  if (compact.startsWith('+')) {
    return compact;
  }
  if (compact.startsWith('00')) {
    return `+${compact.slice(2)}`;
  }
  if (compact.startsWith('0')) {
    return `+92${compact.slice(1)}`;
  }
  if (compact.startsWith('92')) {
    return `+${compact}`;
  }
  return `+92${compact}`;
};

export default typedPhoneToE164;
