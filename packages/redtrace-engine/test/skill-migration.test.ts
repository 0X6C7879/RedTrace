import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
test('one-time Skills relocation keeps root bytes, disabled state and complete retired archives',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'console-skill-migrate-')),root=dir+'/project',backup=dir+'/archive'
 try{
  for(const p of ['skills/a','skills/off','.redtrace/skills/a','.redtrace/skills/custom','.redtrace/disabled-skills/off'])mkdirSync(root+'/'+p,{recursive:true})
  writeFileSync(root+'/skills/a/SKILL.md','root latest');writeFileSync(root+'/skills/off/SKILL.md','root disabled latest');writeFileSync(root+'/.redtrace/skills/a/SKILL.md','old managed');writeFileSync(root+'/.redtrace/skills/custom/SKILL.md','custom retained');writeFileSync(root+'/.redtrace/disabled-skills/off/SKILL.md','old disabled');writeFileSync(root+'/.redtrace/disabled-skills/off/.redtrace.json',JSON.stringify({version:7}))
  const script=new URL('../../../scripts/migrate-skill-catalog.mjs',import.meta.url).pathname
  const result=JSON.parse(execFileSync(process.execPath,[script,'--root',root,'--backup',backup],{encoding:'utf8'}))
  assert.equal(readFileSync(root+'/skills/a/SKILL.md','utf8'),'root latest');assert.equal(readFileSync(root+'/skills/custom/SKILL.md','utf8'),'custom retained');assert.equal(readFileSync(root+'/skills/.disabled/off/SKILL.md','utf8'),'root disabled latest')
  assert.equal(readFileSync(backup+'/skills/a/SKILL.md','utf8'),'old managed');assert.equal(readFileSync(backup+'/disabled-skills/off/SKILL.md','utf8'),'old disabled')
  assert.equal(JSON.parse(readFileSync(root+'/skills/.disabled/off/.redtrace.json','utf8')).version,7);assert.equal(existsSync(root+'/.redtrace/skills'),false);assert.equal(existsSync(root+'/.redtrace/disabled-skills'),false);assert.ok(result.changes.some((c:any)=>c.action==='use-root-and-archive-difference'))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
