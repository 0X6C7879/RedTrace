export function extractOutput(text: string, contentType = '') {
  const trimmed = text.trim(), json = /json/i.test(contentType) || /^[\[{]/.test(trimmed)
  if (json) {
    try {
      if (Buffer.byteLength(text)>1024*1024) throw new Error('JSON exceeds 1 MiB analysis budget; read raw evidence in chunks')
      const value = JSON.parse(text)
      return {format:'json',type:Array.isArray(value)?'array':typeof value,count:Array.isArray(value)?value.length:null,keys:value && typeof value==='object' ? Object.keys(value).slice(0,20):[],parseError:null}
    } catch (error) { return {format:'json',parseError:String(error),read:'Read raw evidence; no result inferred'} }
  }
  return {format:'text',urls:[...new Set(text.match(/https?:\/\/[^\s<>"']+/g)??[])].slice(0,20),ports:[...text.matchAll(/^\s*(\d+)\/(tcp|udp)\s+(open|closed|filtered)\s*([^\r\n]*)/gm)].slice(0,30).map(m=>({port:Number(m[1]),protocol:m[2],state:m[3],service:m[4]})),errorLines:text.split('\n').filter(line=>/\b(error|failed|timeout|denied)\b/i.test(line)).slice(0,5).map(line=>line.slice(0,200))}
}
