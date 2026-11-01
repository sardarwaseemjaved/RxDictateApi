/**
 * Make typed text safe to put inside a `$regex`, so a search for "a.b" or "(x"
 * matches those characters rather than being read as a pattern - and so a
 * crafted query cannot become an expensive one.
 */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default escapeRegex;
