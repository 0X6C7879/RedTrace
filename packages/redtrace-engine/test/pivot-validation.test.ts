import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createServer } from 'node:http'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { dispatchVerb } from '../src/capability-verbs.ts'
test('SSH and Chisel route validation reaches the scoped target through SOCKS, not just its listener',async()=>{
 const target=createServer((_req,res)=>res.end('authorized fixture'))
 await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve))
 const targetPort=(target.address() as net.AddressInfo).port
 let connections=0
 const sockets=new Set<net.Socket>()
 const proxy=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})
  let buffer=Buffer.alloc(0),phase=0
  socket.on('data',chunk=>{
   if(phase===2)return
   buffer=Buffer.concat([buffer,chunk])
   if(phase===0){if(buffer.length<2+buffer[1]!)return;buffer=buffer.subarray(2+buffer[1]!);socket.write(Buffer.from([5,0]));phase=1}
   if(phase===1){
    if(buffer.length<5)return
    const atyp=buffer[3],length=atyp===1?10:atyp===3?7+buffer[4]!:0
    if(!length||buffer.length<length)return
    const host=atyp===1?[...buffer.subarray(4,8)].join('.'):buffer.subarray(5,5+buffer[4]!).toString(),port=buffer.readUInt16BE(length-2)
    phase=2;connections++
    const upstream=net.createConnection({host,port});sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream))
    upstream.on('connect',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));socket.pipe(upstream);upstream.pipe(socket)})
    upstream.on('error',()=>{socket.end(Buffer.from([5,5,0,1,0,0,0,0,0,0]))});socket.on('close',()=>upstream.destroy())
   }
  })
 })
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve))
 const proxyPort=(proxy.address() as net.AddressInfo).port,store=new Store(':memory:'),ops=new Operations(store,process.cwd())
 const project=store.createProject({title:'Proxy test',origin:`http://127.0.0.1:${targetPort} http://127.0.0.1:1`,goal:'Verify route'}).project
 try {
  for(const provider of ['ssh-forward','chisel']){
   const route=ops.create(project.id,{kind:'proxy',name:provider,status:'available',target:`http://127.0.0.1:${targetPort}`,metadata:{provider,socks_endpoint:`127.0.0.1:${proxyPort}`,target_scope:`http://127.0.0.1:${targetPort}`}}).resource
   const context={projectId:project.id,worker:'fixture',stepId:null,signal:new AbortController().signal}
   const result=await dispatchVerb({operations:ops},'pivot.validate',{via:route.id,url:`http://127.0.0.1:${targetPort}`},context)
   assert.equal(result.http_status,200);assert.ok(ops.pivots.paths(project.id,`http://127.0.0.1:${targetPort}`).some(p=>p.id===route.id))
   const other=store.createProject({title:'Other',origin:'Other',goal:'Other'}).project
   await assert.rejects(dispatchVerb({operations:ops},'pivot.validate',{via:route.id,url:`http://127.0.0.1:${targetPort}`},{...context,projectId:other.id}),/不在可用通道/)
   ops.lease(ops.resource(route.id),{owner:'another-worker',owner_type:'worker',ttl_seconds:60})
   await assert.rejects(dispatchVerb({operations:ops},'pivot.validate',{via:route.id,url:`http://127.0.0.1:${targetPort}`},context),/lease belongs/)
   ops.releaseLease(ops.resource(route.id),{actor:'another-worker',actor_type:'worker',fencing_token:2})
   await assert.rejects(dispatchVerb({operations:ops},'pivot.validate',{via:route.id,url:'http://127.0.0.1:1'},context))
   assert.equal(ops.resource(route.id).status,'degraded');assert.equal(JSON.parse(ops.resource(route.id).metadata_json).runtime_verified,false)
  }
  assert.ok(connections>=4)
  assert.throws(()=>ops.pivots.open(project.id,{provider:'ligolo'}),/Ligolo remains disabled/)
 } finally {await ops.close();store.close();for(const socket of sockets)socket.destroy();await Promise.all([new Promise<void>(resolve=>target.close(()=>resolve())),new Promise<void>(resolve=>proxy.close(()=>resolve()))])}
})

import { existsSync } from 'node:fs'
import path from 'node:path'
test('managed local Chisel server/client forwards to an HTTP fixture and invalidates on upstream close',{skip:!existsSync(path.join(process.cwd(),'tools/bin/chisel'))},async()=>{
 const freePort=async()=>{const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port}
 const listen=async(port:number)=>{
  for(let i=0;i<100;i++){
   const ready=await new Promise<boolean>(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))})
   if(ready)return;await new Promise(resolve=>setTimeout(resolve,50))
  }
  throw new Error('Managed Chisel listener did not start')
 }
 const target=createServer((_req,res)=>res.end('fixture reached through managed Chisel'))
 await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve))
 const targetPort=(target.address() as net.AddressInfo).port,serverPort=await freePort(),socksPort=await freePort(),store=new Store(':memory:'),ops=new Operations(store,process.cwd())
 const url=`http://127.0.0.1:${targetPort}`,project=store.createProject({title:'Managed local route',origin:url,goal:'Verify Chisel process route'}).project
 try {
  const server=ops.pivots.open(project.id,{provider:'chisel',mode:'server',bind_host:'127.0.0.1',bind_port:serverPort,target_scope:url})
  await listen(serverPort)
  const client=ops.pivots.open(project.id,{provider:'chisel',mode:'client',server:`http://127.0.0.1:${serverPort}`,remote:`127.0.0.1:${socksPort}:socks`,socks_endpoint:`127.0.0.1:${socksPort}`,target_scope:url,source_session_id:server.route.id})
  await listen(socksPort)
  assert.deepEqual(ops.pivots.paths(project.id,url),[])
  assert.equal((await ops.pivots.validate(client.route.id,{url})).http_status,200)
  assert.equal(ops.pivots.paths(project.id,url).length,1)
  await ops.pivots.close(server.route.id)
  assert.equal(JSON.parse(ops.resource(client.route.id).metadata_json).runtime_verified,false)
  assert.deepEqual(ops.pivots.paths(project.id,url),[])
 } finally {await ops.close();store.close();await new Promise<void>(resolve=>target.close(()=>resolve()))}
})
