import QRCode from 'qrcode';

/**
 * A QR code as an SVG, one unit per module.
 *
 * Error correction M: a printout gets folded, stamped and written on, and M
 * still reads with about 15% of the code lost, without making the code so
 * dense that a cheap phone camera struggles. No quiet zone, because the page
 * it is printed on leaves its own space around it.
 *
 * Drawn here from the library's module matrix rather than with its async SVG
 * writer, so the printout can put it inline without becoming async. Each run
 * of dark modules in a row is one rectangle, on a white square, and there is
 * no width or height: whoever shows it sizes it.
 */
export const qrSvg = (text: string): string => {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size } = modules;

  const runs = Array.from({ length: size }, (_row, y) => {
    let path = '';
    let start = -1;
    for (let x = 0; x <= size; x += 1) {
      const dark = x < size && Boolean(modules.get(y, x));
      if (dark && start < 0) {
        start = x;
      } else if (!dark && start >= 0) {
        path += `M${start} ${y}h${x - start}v1h${start - x}z`;
        start = -1;
      }
    }
    return path;
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${runs}"/></svg>`
  );
};

export default qrSvg;
