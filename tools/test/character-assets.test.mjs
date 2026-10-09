import test from 'node:test';
import assert from 'node:assert/strict';
import {CHARACTER_ASSET_MANIFEST,main,validateProjectPath} from '../../scripts/fetch-character-assets.mjs';

test('character asset fetcher pins versions and rejects project traversal',async()=>{
  const result=await main(['--selftest']);assert.equal(result.status,'PASS');
  assert.equal(Object.keys(CHARACTER_ASSET_MANIFEST).length,4);
  for(const item of Object.values(CHARACTER_ASSET_MANIFEST))assert.match(item.sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>validateProjectPath('projects/../escape'),/existing projects/);
  assert.throws(()=>validateProjectPath('projects/UPPER'),/existing projects/);
});
