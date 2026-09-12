// Real TARGET scripts in the wild are frequently UTF-16 (Thrustmaster's own editor
// writes them that way). Reading one as UTF-8 produces silent garbage rather than an
// error, so every file read off disk sniffs the byte-order mark first.

import * as fs from 'fs';

export function decodeBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

export function readTextFile(p: string): string | null {
  try {
    return decodeBuffer(fs.readFileSync(p));
  } catch {
    return null;
  }
}
