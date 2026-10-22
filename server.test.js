'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {server, rooms}=require('./server');
let base;
test.before(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));});
const call=async(endpoint,body)=>{const r=await fetch(base+'/api/match/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {code:r.status,...await r.json()}};
test('serves chess entry point', async()=>{const r=await fetch(base+'/');assert.equal(r.status,200);assert.match(await r.text(),/livePublicTwo/)});
test('matches two clients but not a third into the occupied table',async()=>{
 rooms.clear();
 const a='player-aaaaa111111', b='player-bbbbb222222',c='player-ccccc333333';
 const h=await call('join',{clientId:a,time:10});assert.equal(h.role,'host');assert.match(h.room,/^EUGEN-[0-9A-F]{14}$/);
 await call('heartbeat',{clientId:a,room:h.room,ready:true});
 const g=await call('join',{clientId:b,time:10});assert.equal(g.role,'guest');assert.equal(g.room,h.room);
 const third=await call('join',{clientId:c,time:10});assert.equal(third.role,'host');assert.notEqual(third.room,h.room);
 const still=await call('join',{clientId:a,time:10});assert.equal(still.room,h.room);
 const leave=await call('leave',{clientId:a,room:h.room});assert.equal(leave.ok,true);
 assert.equal(rooms.has(h.room),false);
});
test('time control separates waiting players',async()=>{
 rooms.clear();
 const a='player-ddddd444444',b='player-eeeee555555';
 const h=await call('join',{clientId:a,time:3});await call('heartbeat',{clientId:a,room:h.room,ready:true});
 const second=await call('join',{clientId:b,time:15});assert.equal(second.role,'host');assert.notEqual(h.room,second.room);
});
test('rejects unfamiliar client and forged heartbeats',async()=>{
 rooms.clear();
 assert.equal((await call('join',{clientId:'bad',time:10})).code,400);
 const h=await call('join',{clientId:'player-fffff666666',time:10});
 assert.equal((await call('heartbeat',{clientId:'player-zzzzz777777',room:h.room,ready:true})).code,404);
});
