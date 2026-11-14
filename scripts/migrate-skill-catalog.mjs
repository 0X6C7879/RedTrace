// One-time relocation; the running catalog never reads the retired managed copies.
import { readdir, readFile, mkdir, rename, cp, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
const {values}=parseArgs({options:{root:{type:'string',default:process.cwd()},backup:{type:'string'}}})
if(!values.backup)throw Error('--backup DIRECTORY is required to retain the retired catalog bytes')
const root=path.resolve(values.root),backup=path.resolve(values.backup),catalog=path.join(root,'skills'),changes=[]
await mkdir(backup) // A fresh backup must not overwrite a previous archive.
await mkdir(path.join(catalog,'.disabled'),{recursive:true})
const exists=async p=>{try{await access(p);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
for(const [legacy,disabled] of [['skills',false],['disabled-skills',true]]){
  const old=path.join(root,'.redtrace',legacy)
  if(!await exists(old))continue
  for(const entry of await readdir(old,{withFileTypes:true})){
    const from=path.join(old,entry.name)
    if(!entry.isDirectory()||entry.name.startsWith('.'))continue
    const enabled=path.join(catalog,entry.name),target=disabled?path.join(catalog,'.disabled',entry.name):enabled
    if(disabled&&await exists(enabled)){
      await rename(enabled,target);changes.push({name:entry.name,action:'preserve-disabled',path:target})
    }else if(!await exists(target)){
      await cp(from,target,{recursive:true});changes.push({name:entry.name,action:'import',path:target})
    }else{
      const same=await exists(from+'/SKILL.md')&&await exists(target+'/SKILL.md')&&(await readFile(from+'/SKILL.md')).equals(await readFile(target+'/SKILL.md'))
      changes.push({name:entry.name,action:same?'use-root':'use-root-and-archive-difference',path:target})
    }
    const metadata=path.join(from,'.redtrace.json'),state=path.join(target,'.redtrace.json')
    if(await exists(metadata)&&!await exists(state)){await cp(metadata,state);changes.push({name:entry.name,action:'preserve-metadata',path:state})}
  }
  const history=path.join(old,'.redtrace'),destination=path.join(catalog,'.redtrace')
  if(await exists(history))await cp(history,destination,{recursive:true,force:false,errorOnExist:false})
  await rename(old,path.join(backup,legacy))
}
await writeFile(path.join(backup,'migration.json'),JSON.stringify({root,catalog,changes},null,2))
console.log(JSON.stringify({root,catalog,backup,changes},null,2))
