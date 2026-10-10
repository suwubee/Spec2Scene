import path from 'node:path';
import os from 'node:os';
import {mkdtemp} from 'node:fs/promises';
import {validateV06} from '../tools/test/v06-browser.mjs';
if (process.argv.includes('--help')) console.log('Usage: node scripts/validate-v06.mjs [temporary-output-directory]\nIsolated generated project; evidence is retained, checkout projects/ is untouched.');
else {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(os.tmpdir(), 'scene-v06-'));
  console.log(`V06 evidence: ${out}`); await validateV06(out);
}
