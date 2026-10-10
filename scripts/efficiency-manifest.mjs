#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Configuration } from '../packages/redtrace-engine/src/config.ts'
const root=path.resolve(import.meta.dirname,'..'), configuration=new Configuration(root,process.argv[2] || path.join(root,'.redtrace/redtrace.yaml'))
const {raw}=configuration.read(), hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','packages/redtrace-engine','packages/redtrace-dsh','scripts'],{cwd:root}).toString().split('\0').filter(file=>file && /\.(?:ts|mjs|json|sql)$/.test(file) && !file.includes('/node_modules/'))
const source=Object.fromEntries([...new Set(files)].sort().map(file=>[file,hash(path.join(root,file))]))
console.log(JSON.stringify({createdAt:new Date().toISOString(),gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),source,configuration:{path:configuration.filename,sha256:hash(configuration.filename)},workers:raw.workers.map(worker=>Object.fromEntries(['name','provider','model','enabled','bootstrap','reason','explore','max_running','priority','backend'].filter(key=>key in worker).map(key=>[key,worker[key]]))),models:Object.fromEntries(Object.entries(raw.providers??{}).map(([name,value])=>[name,value.models.map(model=>Object.fromEntries(['id','context_window','max_tokens','reasoning','reasoning_efforts','thinking_format'].filter(key=>key in model).map(key=>[key,model[key]])))])),plugins:{path:path.join(root,'.redtrace/plugins.json'),sha256:hash(path.join(root,'.redtrace/plugins.json'))},questions:process.argv.slice(3).map(file=>({path:path.resolve(file),sha256:hash(file)})),note:'No credentials exported; configuration hash pins secret references, not secrets. No real benchmark was requested.'},null,2))
