/**
 * Rows of a CSV file, as RFC 4180 writes them: quoted fields may hold commas,
 * line breaks and doubled quotes. A composition has commas in it often enough
 * that splitting on them is not an option. A byte order mark from a spreadsheet
 * is ignored, and so are blank lines.
 */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value.trim() !== '')) {
      rows.push(row);
    }
    row = [];
  };

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char !== '\r') {
      field += char;
    }
  }
  endRow();

  return rows;
};

/**
 * A field as a spreadsheet will read it back. Quoted when it holds a comma, a
 * quote or a line break. A field a spreadsheet would run as a formula gets a
 * leading apostrophe; a phone number such as +92300... is left alone.
 */
const csvField = (value: string): string => {
  const safe = /^[=@\t\r]/.test(value) || /^[+-](?![\d\s]*$)/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Rows as RFC 4180 CSV text, CRLF between rows, the way parseCsv reads them. */
export const toCsv = (rows: string[][]): string => `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;

export default parseCsv;
