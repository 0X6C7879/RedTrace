import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
test('two real DSH Commander Sessions overlap and A events do not wake B',{timeout:30000},async()=>{const {stdout}=await promisify(execFile)(process.execPath,[import.meta.dirname+'/project-commanders.fixture.mjs'],{timeout:25000});assert.match(stdout,/PROJECT_COMMANDERS_CONCURRENT=true/);assert.match(stdout,/commander_cwd=task_root/);assert.match(stdout,/legacy_session_resumed=true/);console.log(stdout.trim())})
