import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {InteractiveService} from '../build/services/interactive.js';

function setup() {
  const client=new EventEmitter(); client.setMaxListeners(0);
  const cancelled=[]; client.unforwardIn=(host,port,cb)=>{cancelled.push(port);cb?.();};
  let alive=true;
  const manager={connect:async()=>{},getClient:()=>{if(!alive)throw Error('Disconnected');return client;},getConfig:()=>({})};
  return {client,manager,cancelled,disconnect:()=>{alive=false;client.emit('close');},service:new InteractiveService(manager)};
}
for(const direction of ['local','remote']) test(`${direction} forward cannot finish after service shutdown during connection`,async()=>{
  const f=setup();let release;f.manager.connect=()=>new Promise(resolve=>{release=resolve;});
  f.client.forwardIn=(_host,_port,cb)=>cb(null,42001);
  const pending=direction==='local'?f.service.forward('127.0.0.1',22):f.service.reverseForward('127.0.0.1',22);
  f.service.close();release();
  try{await assert.rejects(pending,/clos|chang|disconnect/i);assert.deepEqual(f.service.listForwards(),[]);}finally{f.service.close();}
});
test('local listener opened while SSH closes is cleaned instead of registered',async()=>{
  const f=setup(),listen=net.Server.prototype.listen;let listener;
  net.Server.prototype.listen=function(...args){listener=this;this.once('listening',f.disconnect);return listen.apply(this,args);};
  try {await assert.rejects(f.service.forward('127.0.0.1',22),/clos|chang|disconnect/i);assert.equal(listener.listening,false);assert.deepEqual(f.service.listForwards(),[]);}
  finally{net.Server.prototype.listen=listen;f.service.close();listener?.close();}
});
for(const reason of ['shutdown','disconnect']) test(`late reverse-forward allocation is cancelled after ${reason}`,async()=>{
  const f=setup();let allocated,ready;const started=new Promise(resolve=>{ready=resolve;});
  f.client.forwardIn=(_host,_port,cb)=>{allocated=cb;ready();};
  const pending=f.service.reverseForward('127.0.0.1',22);const rejected=assert.rejects(pending,/clos|chang|disconnect/i);
  await started;if(reason==='shutdown')f.service.close();else f.disconnect();allocated(null,42002);
  try{await rejected;assert.deepEqual(f.cancelled,[42002]);assert.equal(f.client.listenerCount('tcp connection'),0);assert.deepEqual(f.service.listForwards(),[]);}finally{f.service.close();}
});
for(const direction of ['local','remote']) test(`${direction} pending forwards count toward capacity and release their slots`,async()=>{
  const f=setup();let release,port=42010;const gate=new Promise(resolve=>{release=resolve;});f.manager.connect=()=>gate;
  f.client.forwardIn=(_host,_port,cb)=>cb(null,port++);
  const start=()=>direction==='local'?f.service.forward('127.0.0.1',22):f.service.reverseForward('127.0.0.1',22);
  const pending=Array.from({length:32},start);
  try{await assert.rejects(start(),/limit/);release();await Promise.all(pending);assert.equal(f.service.listForwards().length,32);f.service.close();await start();assert.equal(f.service.listForwards().length,1);}
  finally{release();await Promise.allSettled(pending);f.service.close();}
});
test('unanswered reverse-forward request times out and cancels a late allocation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=setup();let allocated,ready;const started=new Promise(resolve=>{ready=resolve;});
  f.client.forwardIn=(_host,_port,cb)=>{allocated=cb;ready();};
  const pending=f.service.reverseForward('127.0.0.1',22),rejected=assert.rejects(pending,/timed out/);
  await started;t.mock.timers.tick(10001);await rejected;allocated(null,42100);
  assert.deepEqual(f.cancelled,[42100]);assert.equal(f.client.listenerCount('close'),0);assert.deepEqual(f.service.listForwards(),[]);f.service.close();
});
