/** xss-clean ships no types of its own. */
declare module 'xss-clean' {
  import type { RequestHandler } from 'express';

  function xss(): RequestHandler;
  export = xss;
}
