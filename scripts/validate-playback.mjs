import path from 'node:path';
import os from 'node:os';
import {mkdtemp} from 'node:fs/promises';
import {validateGeneratedRealtime} from '../tools/test/realtime-browser.mjs';
if(process.argv.includes('--help'))console.log('Usage: node scripts/validate-playback.mjs [temporary-output-directory]\nGenerates an isolated sample; retains playback metrics and screenshots.');
else {
  const out=process.argv[2]?path.resolve(process.argv[2]):await mkdtemp(path.join(os.tmpdir(),'scene-playback-'));
  console.log(`Playback evidence: ${out}`);await validateGeneratedRealtime(out);
}
