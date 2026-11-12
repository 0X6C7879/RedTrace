import test from'node:test'
import assert from'node:assert/strict'
import{execFile}from'node:child_process'
import{promisify}from'node:util'
const exec=promisify(execFile)
for(const compression of ['none','zstd'])test('E7 native '+compression+' Session deletion retains attachments/findings and exact hashes',{timeout:90000},async()=>{const root=new URL('../../..',import.meta.url).pathname;const r=await exec(process.execPath,[new URL('./legion-cutover.fixture.mjs',import.meta.url).pathname,root,root,compression]);assert.match(r.stdout,/CUTOVER_NATIVE_ACCEPTANCE=true/);assert.match(r.stdout,/dangling_active_refs=0/);assert.match(r.stdout,/hashes_unchanged=true/)})

test('E7 CLI verifies backup reconstruction before reset and migrates configuration without losing credentials',{timeout:90000},async()=>{const r=await exec(process.execPath,[new URL('./legion-cutover-cli.fixture.mjs',import.meta.url).pathname]);assert.match(r.stdout,/CUTOVER_CLI_ACCEPTANCE=true/);assert.match(r.stdout,/consistent_backup_reconstructed=true/);assert.match(r.stdout,/credentials_preserved=true/)})
