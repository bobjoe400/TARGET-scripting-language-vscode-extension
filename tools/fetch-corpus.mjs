// Downloads publicly available TARGET scripts to test against.
//
// Fetched, never vendored. Most of these repositories carry no licence at all, which
// means all rights reserved - copying them into this MIT repo would not be ours to do.
// Each developer pulls them themselves, into a gitignored directory, and they stay
// current as their authors change them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPOS = [
  'aboutflash/StarCitizen-WarthogScript',
  'AndySupraTT/Solarfly_Warthog_StarCitizen_3_0_0_7',
  'Astro-739/DCS-TM_Warthog_Scripts',
  'Aussiedroid/AD-EDWarthogEnhancedScript',
  'barnacker/sol-r-2-star-citizen',
  'blob42/Warthog-Hotas-Scripts',
  'bofhgr/TM-Target-Profile-for-SC-by-qp',
  'ClickerNZ/ED_Enhanced_T16000',
  'ClickerNZ/ED_Enhanced_Warthog',
  'darksuji/elite-warthog',
  'grufffta/elite-thrustmaster-fcs',
  'jandadav/DCS-F14-WT-profile',
  'lythix/EliteWarthog',
  'mccawley74/StarCitizen-KillCrazy',
  'Net-burst/Elite-Dangerous-Warthog-Profile',
  'solarfly73/starcitizen_tmhotas',
  'TarodBOFH/ThrustmasterTARGETScripting',
  'Touille/ED-Warthog-Target-Script',
  'tpn/hotas',
  'whartsell/Target-Profiles',
  'zeplintwo/FS19-TARGET-SCRIPT-Profiles',
];

const root = path.resolve(process.argv[2] ?? 'corpus');
fs.mkdirSync(root, { recursive: true });
const SCRIPT = /\.(tmc|tmh|ttm)$/i;

let repos = 0, files = 0;
for (const repo of REPOS) {
  const dest = path.join(root, repo.replace('/', '__'));
  if (fs.existsSync(dest)) {
    const n = countScripts(dest);
    console.log(`  have  ${repo.padEnd(50)} ${n} files`);
    repos++; files += n;
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  try {
    // Through gh, so the authenticated rate limit applies rather than 60/hour.
    const tgz = path.join(tmp, 'r.tar.gz');
    execFileSync('gh', ['api', `repos/${repo}/tarball`], { stdio: ['ignore', fs.openSync(tgz, 'w'), 'ignore'] });
    execFileSync('tar', ['xzf', tgz, '-C', tmp]);
    const inner = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.statSync(d).isDirectory());
    const kept = copyScripts(inner, dest);
    if (kept === 0) { fs.rmSync(dest, { recursive: true, force: true }); console.log(`  none  ${repo}`); }
    else { console.log(`  got   ${repo.padEnd(50)} ${kept} files`); repos++; files += kept; }
  } catch (e) {
    console.log(`  FAIL  ${repo.padEnd(50)} ${String(e.message).split('\n')[0].slice(0, 60)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`\n${files} script files from ${repos} repositories in ${root}`);

function copyScripts(from, to) {
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    if (e.isDirectory()) { n += copyScripts(src, path.join(to, e.name)); continue; }
    if (!SCRIPT.test(e.name)) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(src, path.join(to, e.name));
    n++;
  }
  return n;
}
function countScripts(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countScripts(path.join(dir, e.name));
    else if (SCRIPT.test(e.name)) n++;
  }
  return n;
}
