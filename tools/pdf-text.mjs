// Positional PDF text extraction, shared by the generators that read Thrustmaster's
// manuals.
//
// The naive approach - concatenating Tj/TJ runs in stream order - interleaves the
// columns of a two-column page and breaks words apart, because a TJ array's numeric
// elements are kerning adjustments and treating every one as a space turns "creating"
// into "cr eating". This tracks the text matrix, groups runs into lines by their Y
// coordinate, orders them by X, and only treats a LARGE negative adjustment as a space.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function pdfPages(file) {
  const data = fs.readFileSync(file);
  const pages = [];
  let i = 0;
  while (true) {
    const s = data.indexOf('stream', i);
    if (s === -1) break;
    let st = s + 6;
    if (data[st] === 0x0d) st++;
    if (data[st] === 0x0a) st++;
    const e = data.indexOf('endstream', st);
    if (e === -1) break;
    let raw;
    try { raw = zlib.inflateSync(data.subarray(st, e)); } catch { i = e + 9; continue; }
    const runs = contentRuns(raw.toString('latin1'));
    if (runs.length) pages.push(runs);
    i = e + 9;
  }
  return pages;
}

function contentRuns(src) {
  const runs = [];
  // Text state: the matrix gives position; Td/TD/T* move the line.
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = tm.slice();
  let leading = 0;
  const tok = /(BT)|(ET)|\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|([-\d.]+)\s+TL|([-\d.]+)\s+([-\d.]+)\s+(Td|TD)|((?:[-\d.]+\s+){6})Tm|(T\*)/g;
  let m;
  while ((m = tok.exec(src))) {
    if (m[1]) { tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); continue; }
    if (m[2]) continue;
    if (m[6] !== undefined) { leading = -parseFloat(m[6]); continue; }
    if (m[9]) {
      const tx = parseFloat(m[7]), ty = parseFloat(m[8]);
      if (m[9] === 'TD') leading = -ty;
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx, tlm[5] + ty];
      tm = tlm.slice();
      continue;
    }
    if (m[10]) { const n = m[10].trim().split(/\s+/).map(Number); tm = n; tlm = n.slice(); continue; }
    if (m[11]) { tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4], tlm[5] - leading]; tm = tlm.slice(); continue; }

    let text = '';
    if (m[3] !== undefined) {
      // TJ: a numeric element is a kern. Only a LARGE negative one is a real space -
      // small ones are letter spacing, and treating those as spaces is what produced
      // "cr eating".
      for (const part of m[3].matchAll(/\(((?:[^()\\]|\\.)*)\)|(-?[\d.]+)/g)) {
        if (part[1] !== undefined) text += unescape(part[1]);
        else if (parseFloat(part[2]) < -180) text += ' ';
      }
    } else if (m[4] !== undefined) {
      text = unescape(m[4]);
    }
    if (text) runs.push({ x: tm[4], y: tm[5], text });
  }
  return runs;
}

/**
 * Windows-1252 punctuation, read back as ASCII.
 *
 * The manual is typeset with smart quotes and en dashes, which the PDF stores in the
 * CP1252 high range. Read as latin1 they arrive as chars 145-151, so a sentence about
 * a button turning OFF contains "OFF" in curly quotes - close enough to look right in
 * a terminal and different enough to fail a string comparison.
 */
export function normalizeText(s) {
  return s
    .replace(/[\u0091\u0092\u2018\u2019]/g, "'")
    .replace(/[\u0093\u0094\u201c\u201d]/g, '"')
    .replace(/[\u0096\u0097\u2013\u2014]/g, '-')
    .replace(/[\u0085\u2026]/g, '...')
    .replace(/[\u0095\u2022]/g, '*')
    .replace(/\u00a0/g, ' ');
}

const unescape = (s) => s.replace(/\\([()\\])/g, '$1').replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/** Runs grouped into lines by Y, ordered by X, with columns kept apart. */
export function pageLines(runs) {
  const byY = new Map();
  for (const r of runs) {
    const key = Math.round(r.y / 2) * 2;      // tolerate sub-point drift
    if (!byY.has(key)) byY.set(key, []);
    byY.get(key).push(r);
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])              // top of page first
    .map(([, rs]) => normalizeText(rs.sort((a, b) => a.x - b.x).map((r) => r.text).join('')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
