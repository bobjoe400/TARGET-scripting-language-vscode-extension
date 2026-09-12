// Real TARGET scripts in the wild are frequently UTF-16 (Thrustmaster's own editor
// writes them that way). Reading one as UTF-8 produces silent garbage rather than an
// error, so every file read off disk sniffs the byte-order mark first.

import * as fs from 'fs';

export function decodeBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // swap16 throws on an odd byte count, and readTextFile would turn that into null -
    // making the file invisible to the include graph rather than merely truncated.
    // A trailing odd byte is damage either way; drop it and read what is there.
    const body = buf.subarray(2);
    const even = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1);
    const swapped = Buffer.from(even);
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
