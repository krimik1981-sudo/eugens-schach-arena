'use strict';
// Eugens Schach Arena v72 — accounts + friendships stored in Supabase.
// Requires Node.js 18+, SUPABASE_URL and SUPABASE_SECRET_KEY in Render Environment.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET = String(process.env.SUPABASE_SECRET_KEY || '');
if (!/^https:\/\/[^/]+$/.test(BASE) || !SECRET) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Keep both in Render Environment, not in source code.');
  process.exit(1);
}
const tokenSecret = crypto.createHmac('sha256', SECRET).update('eugens-schach-arena/v72/session').digest();
const key = s => String(s || '').trim().toLocaleLowerCase('de');
const allowedName = s => typeof s === 'string' && /^[\p{L}\p{N}_ .-]{3,28}$/u.test(s.trim());
const passwordOk = s => typeof s === 'string' && s.length >= 10 && s.length <= 128;
const hash = (pwd, salt) => crypto.scryptSync(pwd, Buffer.from(salt, 'hex'), 64).toString('hex');
const pub = a => ({ code: a.code, name: a.name, avatar: '♟️' });
const reply = (res, status, body) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
};
function tokenFor(a) {
  const payload = Buffer.from(JSON.stringify({id:a.id,exp:Date.now()+30*86400000})).toString('base64url');
  const sig = crypto.createHmac('sha256',tokenSecret).update(payload).digest('base64url');
  return payload+'.'+sig;
}
function authId(req) {
  const token = (req.headers.authorization || '').match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  const [payload,sig,extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256',tokenSecret).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    return Number.isSafeInteger(p.exp) && p.exp > Date.now() && /^[0-9a-f-]{36}$/i.test(p.id) ? p.id : null;
  } catch { return null; }
}
class DatabaseError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}
async function db(table, method='GET', params={}, body) {
  const url = new URL(BASE+'/rest/v1/'+table);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
  const headers = {'apikey':SECRET,'Content-Type':'application/json','Accept':'application/json'};
  // New sb_secret_* keys are opaque, not JWTs: never put them into Bearer.
  if (!SECRET.startsWith('sb_secret_')) headers.Authorization = 'Bearer '+SECRET;
  if (method !== 'GET') headers.Prefer = 'return=representation';
  if (method==='POST' && params.on_conflict) headers.Prefer = 'resolution=merge-duplicates,return=representation';
  let resp;
  try { resp = await fetch(url,{method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(12000)}); }
  catch (e) { throw new DatabaseError('Supabase nicht erreichbar.',503,e.message); }
  let data; try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) throw new DatabaseError('Datenbankabfrage fehlgeschlagen.',resp.status,data);
  return data || [];
}
const accounts = (params, method='GET', body) => db('arena_accounts',method,params,body);
const relationships = (params, method='GET', body) => db('arena_friendships',method,params,body);
const invitations = (params, method='GET', body) => db('arena_invites',method,params,body);
async function findName(name) { return (await accounts({nick_key:'eq.'+key(name),select:'*',limit:1}))[0] || null; }
async function findCode(code) { return (await accounts({code:'eq.'+String(code || '').trim().toUpperCase(),select:'*',limit:1}))[0] || null; }
async function findId(id) { return (await accounts({id:'eq.'+id,select:'*',limit:1}))[0] || null; }
async function pair(a,b) {return a < b ? [a,b] : [b,a];}
async function relation(a,b) {
  const [player1_id,player2_id] = await pair(a,b);
  return (await relationships({player1_id:'eq.'+player1_id,player2_id:'eq.'+player2_id,select:'*',limit:1}))[0] || null;
}
async function lists(a) {
  const rels = await relationships({or:'(player1_id.eq.'+a.id+',player2_id.eq.'+a.id+')',select:'*',limit:300});
  const ids = [...new Set(rels.map(r=>r.player1_id===a.id?r.player2_id:r.player1_id))];
  const others = ids.length ? await accounts({id:'in.('+ids.join(',')+')',select:'id,code,name'}) : [];
  const byId = new Map(others.map(x=>[x.id,x]));
  const friends=[], incoming=[], outgoing=[];
  for(const r of rels) {
    const target = byId.get(r.player1_id===a.id?r.player2_id:r.player1_id);
    if (!target) continue;
    if(r.status==='accepted') friends.push(pub(target));
    else if(r.status==='pending') {
      if(r.requested_by===a.id) outgoing.push({id:r.id,to:pub(target)});
      else incoming.push({id:r.id,from:pub(target)});
    }
  }
  return {profile:pub(a),friends,incoming,outgoing};
}
// Public matchmaking for Chess and Dame. Rooms are intentionally transient:
// PeerJS carries the moves; Supabase remains the durable account/friend store.
const matchQueues = {chess:new Map(),dame:new Map()};
const MATCH_TTL=45000;
const clientValid = v => typeof v==='string' && /^[cd][a-f0-9]{32}$/.test(v);
const roomValid = v => typeof v==='string' && /^[a-z][a-f0-9]{28}$/.test(v);
async function matchAction(req,res,url) {
  if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
  const dame=url.pathname.startsWith('/api/dame-match/');
  const kind=dame?'dame':'chess';
  const action=url.pathname.slice(dame?'/api/dame-match/'.length:'/api/match/'.length);
  if(!['join','heartbeat','leave'].includes(action))return reply(res,404,{error:'Unknown matchmaking action'});
  let raw='';
  try {for await(const chunk of req){raw+=chunk;if(raw.length>2048)return reply(res,413,{error:'Too large'});}}
  catch{return reply(res,400,{error:'Invalid request'});}
  let data;
  try{data=JSON.parse(raw||'{}')}catch{return reply(res,400,{error:'Invalid JSON'});}
  if(!data || typeof data!=='object' || !clientValid(data.clientId) || (kind==='chess'&&!data.clientId.startsWith('c')) || (kind==='dame'&&!data.clientId.startsWith('d')))
    return reply(res,400,{error:'Invalid client ID'});
  const queue=matchQueues[kind], now=Date.now();
  for(const [room,item] of queue)if(now-item.updated>MATCH_TTL)queue.delete(room);
  if(action==='join') {
    // Prevent duplicate rooms after double taps; do not allow one client to match itself.
    for(const [room,item] of queue)if(item.host===data.clientId || item.guest===data.clientId)
      return reply(res,200,{room,role:item.host===data.clientId?'host':'guest',hostColor:item.hostColor});
    const time=kind==='chess'?Number(data.time)||0:0;
    const preference=['w','b','random'].includes(data.color)?data.color:'random';
    const waiting=[...queue.entries()].find(([room,item])=>item.ready&&!item.guest && (kind==='dame'||item.time===time) && (preference==='random'||preference!==item.hostColor));
    if(waiting) {
      const [room,item]=waiting;item.guest=data.clientId;item.updated=now;
      return reply(res,200,{room,role:'guest',hostColor:item.hostColor});
    }
    let room;
    do {room=(dame?'d':'c')+crypto.randomBytes(14).toString('hex')}while(queue.has(room));
    const hostColor=preference==='random'?(crypto.randomInt(2)?'w':'b'):preference;
    queue.set(room,{host:data.clientId,guest:null,ready:false,time,hostColor,updated:now});
    return reply(res,200,{room,role:'host',hostColor});
  }
  if(!roomValid(data.room))return reply(res,400,{error:'Invalid room'});
  const item=queue.get(data.room);
  if(!item || (item.host!==data.clientId && item.guest!==data.clientId))return reply(res,404,{error:'Room expired or not yours'});
  if(action==='leave') {
    queue.delete(data.room);
    return reply(res,200,{ok:true});
  }
  item.updated=now;
  if(item.host===data.clientId && data.ready===true)item.ready=true;
  return reply(res,200,{ok:true,room:data.room,ready:item.ready,matched:!!item.guest});
}

// Server-authoritative chess clocks (v122). Kept per live Render instance.
const liveClocks=new Map();
const clockRoomValid=s=>typeof s==='string' && (/^EUGEN-[A-F0-9]{14}$/.test(s)||/^[cd][a-f0-9]{28}$/.test(s));
function clockSnapshot(item){
 const now=Date.now(),r={...item.remaining};
 if(item.running && !item.finished && item.minutes>0)r[item.turn]=Math.max(0,r[item.turn]-(now-item.at));
 const timedOut=item.minutes>0 && item.running && r[item.turn]<=0;
 if(timedOut){item.remaining=r;item.at=now;item.running=false;item.finished=true;item.timeout=item.turn}
 return {remaining:r,turn:item.turn,moveNo:item.moveNo,running:item.running,finished:item.finished,timeout:item.timeout||null,minutes:item.minutes,serverAt:now};
}
async function clockEndpointMemory(req,res,url){
 if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
 let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>1024)return reply(res,413,{error:'Too large'})}}catch{return reply(res,400,{error:'Invalid request'})}
 let d;try{d=JSON.parse(raw)}catch{return reply(res,400,{error:'Invalid JSON'})}
 if(!d||!clockRoomValid(d.room))return reply(res,400,{error:'Invalid room'});
 const now=Date.now();for(const [k,v] of liveClocks)if(now-v.updated>7200000)liveClocks.delete(k);
 const action=url.pathname.slice('/api/live-clock/'.length);
 if(action==='start'){
  if(!Number.isInteger(d.minutes)||d.minutes<0||d.minutes>180||typeof d.key!=='string'||!/^[-_a-zA-Z0-9]{30,100}$/.test(d.key))return reply(res,400,{error:'Invalid clock settings'});
  const current=liveClocks.get(d.room);
  if(current && current.key!==d.key)return reply(res,409,{error:'Clock already owned by another host'});
  if(current && current.key===d.key && !d.reset){current.updated=now;return reply(res,200,{...clockSnapshot(current),ok:true})}
  const ms=d.minutes*60000,item={key:d.key,minutes:d.minutes,remaining:{w:ms,b:ms},turn:'w',moveNo:0,running:true,finished:false,at:now,updated:now,timeout:null};
  liveClocks.set(d.room,item);return reply(res,200,{...clockSnapshot(item),ok:true});
 }
 const item=liveClocks.get(d.room);if(!item)return reply(res,404,{error:'Clock not found'});
 item.updated=now;
 if(action==='state')return reply(res,200,{...clockSnapshot(item),ok:true});
 if(d.key!==item.key)return reply(res,403,{error:'Host required'});
 if(action==='move'){
  if(!Number.isSafeInteger(d.moveNo)||d.moveNo!==item.moveNo+1 || !['w','b'].includes(d.turn)||d.turn===item.turn)return reply(res,409,{error:'Clock move out of order',...clockSnapshot(item)});
  const before=clockSnapshot(item);if(item.finished)return reply(res,409,{error:'Time has expired',...before});
  item.remaining=before.remaining;item.moveNo=d.moveNo;item.turn=d.turn;item.at=now;return reply(res,200,{...clockSnapshot(item),ok:true});
 }
 if(action==='finish'){clockSnapshot(item);item.running=false;item.finished=true;return reply(res,200,{...clockSnapshot(item),ok:true})}
 return reply(res,404,{error:'Not found'});
}


// v141: Persist live clock state in Supabase so a Render restart cannot reset it.
// Each state transition uses compare-and-swap on a monotonically increasing revision.
const clockRows = (params, method='GET', body) => db('arena_live_clocks', method, params, body);
async function durableClockEndpoint(req,res,url){
 if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
 let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>1024)return reply(res,413,{error:'Too large'})}}catch{return reply(res,400,{error:'Invalid request'})}
 let d;try{d=JSON.parse(raw||'{}')}catch{return reply(res,400,{error:'Invalid JSON'})}
 if(!d||!clockRoomValid(d.room))return reply(res,400,{error:'Invalid room'});
 const action=url.pathname.slice('/api/live-clock/'.length);
 if(!['start','state','move','finish'].includes(action))return reply(res,404,{error:'Not found'});
 if(action==='start'&&(!Number.isInteger(d.minutes)||d.minutes<0||d.minutes>180||typeof d.key!=='string'||!/^[-_a-zA-Z0-9]{30,100}$/.test(d.key)))return reply(res,400,{error:'Invalid clock settings'});
 for(let attempt=0;attempt<6;attempt++){
  const rows=await clockRows({room:'eq.'+d.room,select:'room,host_key,state,revision',limit:1});
  const row=rows[0]||null;
  if(!row){
   if(action!=='start')return reply(res,404,{error:'Clock not found'});
   const now=Date.now(),ms=d.minutes*60000;
   const item={minutes:d.minutes,remaining:{w:ms,b:ms},turn:'w',moveNo:0,running:true,finished:false,at:now,updated:now,timeout:null};
   try{
    await clockRows({},'POST',{room:d.room,host_key:d.key,state:item,revision:0});
    return reply(res,200,{...clockSnapshot(item),ok:true});
   }catch(e){if(e.status===409)continue;throw e}
  }
  const item=row.state;
  if(!item||!item.remaining||typeof item.at!=='number')return reply(res,503,{error:'Clock data invalid'});
  if(action==='start'&&row.host_key!==d.key)return reply(res,409,{error:'Clock already owned by another host'});
  if((action==='move'||action==='finish')&&row.host_key!==d.key)return reply(res,403,{error:'Host required'});
  const beforeFinished=!!item.finished;
  const snap=clockSnapshot(item); // checks elapsed server time, including time spent disconnected
  let mutate=!beforeFinished&&item.finished;
  if(action==='start'&&d.reset){
   const now=Date.now(),ms=d.minutes*60000;
   Object.assign(item,{minutes:d.minutes,remaining:{w:ms,b:ms},turn:'w',moveNo:0,running:true,finished:false,at:now,updated:now,timeout:null});
   mutate=true;
  }else if(action==='move'){
   if(!Number.isSafeInteger(d.moveNo)||d.moveNo!==item.moveNo+1||!['w','b'].includes(d.turn)||d.turn===item.turn)
    return reply(res,409,{error:'Clock move out of order',...snap});
   if(item.finished)return reply(res,409,{error:'Time has expired',...snap});
   item.remaining=snap.remaining;item.moveNo=d.moveNo;item.turn=d.turn;item.at=Date.now();mutate=true;
  }else if(action==='finish'){
   item.running=false;item.finished=true;mutate=true;
  }
  if(mutate){
   item.updated=Date.now();
   const written=await clockRows({room:'eq.'+d.room,revision:'eq.'+row.revision,select:'revision'},'PATCH',{state:item,revision:row.revision+1});
   if(!written.length)continue; // concurrent transition: reread and retry
  }
  return reply(res,200,{...clockSnapshot(item),ok:true});
 }
 return reply(res,409,{error:'Clock was updated concurrently; bitte erneut versuchen'});
}
// Until the v141 SQL is installed, the pre-existing in-memory clock stays
// available to avoid breaking active games during deployment.
async function clockEndpoint(req,res,url){
 if(!globalThis.__v141ClockReady){
  try{await clockRows({select:'room',limit:1});globalThis.__v141ClockReady=true}
  catch(e){
   if(e.status===404 && (e.details?.code==='42P01'||e.details?.code==='PGRST205'||e.details?.code==='PGRST116')){
    return clockEndpointMemory(req,res,url);
   }
   throw e;
  }
 }
 return durableClockEndpoint(req,res,url);
}


// v127: Confirmed, cross-device friend results. Both authenticated players must
// independently report the same match before it contributes to their balance.
async function bilanzEndpoint(req,res,url){
 if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
 let raw='';try{for await(const c of req){raw+=c;if(raw.length>2048)return reply(res,413,{error:'Too large'})}}catch{return reply(res,400,{error:'Invalid body'})}
 let v={};try{v=JSON.parse(raw||'{}')}catch{return reply(res,400,{error:'Invalid JSON'})}
 const id=authId(req),a=id?await findId(id):null;
 if(!a)return reply(res,401,{error:'Bitte unter Profil anmelden.'});
 const action=url.pathname.slice('/api/bilanz/'.length);
 if(action==='report'){
  if(!/^live-[a-z0-9-]{10,75}$/.test(v.matchId||'')||!['chess','dame'].includes(v.game)||!['w','b'].includes(v.side)||!['w','b','draw'].includes(v.winner)||typeof v.opponent!=='string')return reply(res,400,{error:'Ungültige Partie'});
  const b=await findName(v.opponent);
  if(!b||a.id===b.id||!(await relation(a.id,b.id))|| (await relation(a.id,b.id)).status!=='accepted')return reply(res,403,{error:'Bestätigter Freund nicht gefunden.'});
  const row={match_id:v.matchId,player_id:a.id,opponent_id:b.id,game:v.game,side:v.side,winner:v.winner};
  // Supabase unique (match_id, player_id) prevents repeated counting.
  const existing=(await db('arena_match_reports','GET',{match_id:'eq.'+v.matchId,player_id:'eq.'+a.id,select:'match_id,player_id,opponent_id,game,side,winner',limit:1}))[0];
  if(existing){
   if(existing.opponent_id!==row.opponent_id||existing.game!==row.game||existing.side!==row.side||existing.winner!==row.winner)return reply(res,409,{error:'Widersprüchliches Spielergebnis'});
  }else await db('arena_match_reports','POST',{},row);
  return reply(res,200,{ok:true,confirmed:false});
 }
 if(action==='list'){
  const rows=await db('arena_match_reports','GET',{or:'(player_id.eq.'+a.id+',opponent_id.eq.'+a.id+')',select:'match_id,player_id,opponent_id,game,side,winner',limit:3000});
  const own=rows.filter(x=>x.player_id===a.id);
  const byPair=new Map(rows.map(x=>[x.match_id+'|'+x.player_id,x]));
  const agg=new Map();
  for(const r of own){
   const other=byPair.get(r.match_id+'|'+r.opponent_id);
   if(!other||other.player_id!==r.opponent_id||other.opponent_id!==a.id||other.game!==r.game||other.side===r.side||other.winner!==r.winner)continue;
   const k=r.opponent_id+'|'+r.game;
   const v=agg.get(k)||{id:r.opponent_id,game:r.game,wins:0,losses:0,draws:0};
   if(r.winner==='draw')v.draws++;
   else if(r.winner===r.side)v.wins++;else v.losses++;
   agg.set(k,v);
  }
  const items=[...agg.values()];
  const ids=[...new Set(items.map(x=>x.id))];
  const players=ids.length?await accounts({id:'in.('+ids.join(',')+')',select:'id,name,code'}):[];
  const names=new Map(players.map(x=>[x.id,x]));
  return reply(res,200,{items:items.map(x=>({...x,name:names.get(x.id)?.name||'Spieler',code:names.get(x.id)?.code||''}))});
 }
 return reply(res,404,{error:'Not found'});
}


// v138: authenticated per-player unfinished match recovery via Supabase.
// Match data is never written for a different account.
async function resumeEndpoint(req,res,url){
 if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
 let raw='';try{for await(const part of req){raw+=part;if(raw.length>60000)return reply(res,413,{error:'Saved game too large'})}}catch{return reply(res,400,{error:'Invalid request'})}
 let v;try{v=JSON.parse(raw||'{}')}catch{return reply(res,400,{error:'Invalid JSON'})}
 const id=authId(req);if(!id)return reply(res,401,{error:'Bitte zuerst anmelden'});
 const action=url.pathname.slice('/api/resume/'.length);
 if(action==='get'){
  const rows=await db('arena_saved_matches','GET',{player_id:'eq.'+id,select:'payload,updated_at',limit:1});
  return reply(res,200,{saved:rows[0]?.payload||null,updated_at:rows[0]?.updated_at||null});
 }
 if(action==='clear'){
  const p=v?.finished;
  if(p && typeof p.room==='string' && clockRoomValid(p.room) &&
     typeof p.recordId==='string' && /^live-[a-z0-9-]{5,90}$/i.test(p.recordId)){
   // Tombstone blocks any delayed autosave for this completed match.
   const previous=(await db('arena_saved_matches','GET',{player_id:'eq.'+id,select:'payload',limit:1}))[0]?.payload;
   if(!previous || previous.room===p.room){
    await db('arena_saved_matches','POST',{on_conflict:'player_id'},
     {player_id:id,payload:{v:2,done:true,room:p.room,recordId:p.recordId,at:Date.now()}});
   }
  }else{
   await db('arena_saved_matches','DELETE',{player_id:'eq.'+id});
  }
  return reply(res,200,{ok:true});
 }
 if(action!=='save')return reply(res,404,{error:'Not found'});
 const p=v?.saved;
 if(!p||p.v!==1||!/^EUGEN-[A-F0-9]{14}$|^[cd][a-f0-9]{28}$/.test(p.room||'')||
    !['w','b'].includes(p.side)||typeof p.host!=='boolean'||!p.state||typeof p.state!=='object'||
    !Array.isArray(p.state.recordMoves)||!Array.isArray(p.state.recordFrames)||
    p.state.recordFrames.length!==p.state.recordMoves.length+1||p.state.recordMoves.length>800||
    p.state.outcome||!Number.isFinite(p.at)||Date.now()-p.at>86400000)
    return reply(res,400,{error:'Ungültiger Spielstand'});
 // Do not resurrect a game that was already marked finished.
 const stored=(await db('arena_saved_matches','GET',{player_id:'eq.'+id,select:'payload',limit:1}))[0]?.payload;
 if(stored?.done && stored.room===p.room)return reply(res,409,{error:'Partie bereits beendet'});
 // No client may submit another player's account ID.
 await db('arena_saved_matches','POST',{on_conflict:'player_id'},
    {player_id:id,payload:{v:1,at:p.at,room:p.room,host:p.host,side:p.side,state:p.state,clockKey:p.clockKey||null}});
 return reply(res,200,{ok:true});
}


// v144: separate Dame match recovery per account; chess recovery is unaffected.
async function dameResumeEndpoint(req,res,url){
 if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
 let raw='';try{for await(const x of req){raw+=x;if(raw.length>10000)return reply(res,413,{error:'Too large'})}}catch{return reply(res,400,{error:'Invalid body'})}
 let v={};try{v=JSON.parse(raw||'{}')}catch{return reply(res,400,{error:'Invalid JSON'})}
 const id=authId(req);if(!id)return reply(res,401,{error:'Bitte anmelden'});
 const action=url.pathname.slice('/api/dame-resume/'.length);
 const table='arena_saved_dame';
 const prior=(await db(table,'GET',{player_id:'eq.'+id,select:'payload',limit:1}))[0]?.payload||null;
 if(action==='get')return reply(res,200,{saved:prior?.done?null:prior});
 if(action==='clear'){
  const room=v?.room;
  if(typeof room!=='string'||!/^(DAME-[A-Z0-9]{8}-[A-Z0-9]{4}|d[a-f0-9]{28})$/.test(room))return reply(res,400,{error:'Invalid room'});
  if(prior?.room===room){
   await db(table,'POST',{on_conflict:'player_id'},{player_id:id,payload:{v:2,done:true,room,at:Date.now()}});
  }
  return reply(res,200,{ok:true});
 }
 if(action!=='save')return reply(res,404,{error:'Not found'});
 const p=v?.saved;
 if(!p||p.v!==1||typeof p.room!=='string'||!/^(DAME-[A-Z0-9]{8}-[A-Z0-9]{4}|d[a-f0-9]{28})$/.test(p.room)||
 !['w','b'].includes(p.side)||typeof p.host!=='boolean'||!p.state||
 !Array.isArray(p.state.board)||p.state.board.length!==64||
 !p.state.board.every(x=>x===null||['w','W','b','B'].includes(x))||
 !['w','b'].includes(p.state.turn)||p.state.gameOver||
 !Number.isSafeInteger(p.state.seq)||typeof p.state.matchId!=='string'||p.state.matchId.length>100||
 !Number.isFinite(p.at)||Date.now()-p.at>86400000||p.at>Date.now()+10000)
 return reply(res,400,{error:'Invalid Dame save'});
 // Tombstone prevents delayed network autosaves from resurrecting a finished match.
 if(prior?.done&&prior.room===p.room)return reply(res,409,{error:'Partie bereits beendet'});
 if(prior&&!prior.done&&prior.room===p.room&&Number(prior.at)>p.at)
  return reply(res,409,{error:'Old save'});
 await db(table,'POST',{on_conflict:'player_id'},{player_id:id,payload:p});
 return reply(res,200,{ok:true});
}

async function handle(req,res) {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/dame-resume/'))return dameResumeEndpoint(req,res,url);
  if(url.pathname.startsWith('/api/resume/'))return resumeEndpoint(req,res,url);
  if(url.pathname.startsWith('/api/bilanz/'))return bilanzEndpoint(req,res,url);
  if(url.pathname.startsWith('/api/live-clock/'))return clockEndpoint(req,res,url);
  if(url.pathname.startsWith('/api/match/') || url.pathname.startsWith('/api/dame-match/'))return matchAction(req,res,url);
  if(url.pathname.startsWith('/api/invites/')){
    if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
    let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>4096)return reply(res,413,{error:'Anfrage zu groß'});}}catch{return reply(res,400,{error:'Ungültige Anfrage'});}
    let v;try{v=JSON.parse(raw||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw Error();}catch{return reply(res,400,{error:'Ungültiges JSON'});}
    const id=authId(req),me=id?await findId(id):null;
    if(!me)return reply(res,401,{error:'Bitte zuerst anmelden.'});
    const action=url.pathname.slice('/api/invites/'.length);
    const fields='id,from_id,to_id,game,room,status,created_at,expires_at';
    if(action==='list'){
      const rows=await invitations({or:'(from_id.eq.'+me.id+',to_id.eq.'+me.id+')',select:fields,order:'created_at.desc',limit:60});
      const active=rows.filter(x=>new Date(x.expires_at).getTime()>Date.now());
      const ids=[...new Set(active.map(x=>x.from_id).concat(active.map(x=>x.to_id)))];
      const people=ids.length?await accounts({id:'in.('+ids.join(',')+')',select:'id,name,code'}):[];
      const names=Object.fromEntries(people.map(x=>[x.id,x.name]));
      return reply(res,200,{incoming:active.filter(x=>x.to_id===me.id&&x.status==='pending').map(x=>({...x,from_name:names[x.from_id]||'Spieler'})),outgoing:active.filter(x=>x.from_id===me.id&&x.status==='pending').map(x=>({...x,to_name:names[x.to_id]||'Spieler'})),accepted:active.filter(x=>x.from_id===me.id&&x.status==='accepted').map(x=>({...x,to_name:names[x.to_id]||'Spieler'}))});
    }
    if(action==='send'){
      if(!['chess','dame'].includes(v.game)||typeof v.room!=='string'||v.room.length>80||!(v.game==='chess'?/^EUGEN-[A-F0-9]{14}$/.test(v.room):/^DAME-[A-Z0-9]{8}-[A-Z0-9]{4}$/.test(v.room)))return reply(res,400,{error:'Ungültiger Spielraum.'});
      const other=await findCode(v.code);
      if(!other||other.id===me.id)return reply(res,404,{error:'Spieler nicht gefunden.'});
      const friend=await relation(me.id,other.id);
      if(!friend||friend.status!=='accepted')return reply(res,403,{error:'Einladungen sind nur für bestätigte Freunde möglich.'});
      const recent=await invitations({from_id:'eq.'+me.id,to_id:'eq.'+other.id,status:'eq.pending',select:'id,created_at',order:'created_at.desc',limit:10});
      if(recent.some(x=>Date.now()-new Date(x.created_at).getTime()<15000))return reply(res,429,{error:'Bitte 15 Sekunden vor der nächsten Einladung warten.'});
      const expires_at=new Date(Date.now()+5*60000).toISOString();
      const saved=await invitations({select:fields},'POST',{from_id:me.id,to_id:other.id,game:v.game,room:v.room,status:'pending',expires_at});
      return reply(res,200,{ok:true,id:saved[0]?.id,expires_at});
    }
    if(action==='respond'){
      if(typeof v.id!=='string'||!/^[0-9a-f-]{36}$/i.test(v.id)||typeof v.accept!=='boolean')return reply(res,400,{error:'Ungültige Antwort.'});
      const item=(await invitations({id:'eq.'+v.id,to_id:'eq.'+me.id,status:'eq.pending',select:fields,limit:1}))[0];
      if(!item||Date.now()>new Date(item.expires_at).getTime())return reply(res,404,{error:'Einladung abgelaufen oder bereits beantwortet.'});
      const sender=await findId(item.from_id);const friendship=sender?await relation(sender.id,me.id):null;
      if(!friendship||friendship.status!=='accepted')return reply(res,403,{error:'Die Freundschaft ist nicht mehr bestätigt.'});
      const updated=await invitations({id:'eq.'+v.id,to_id:'eq.'+me.id,status:'eq.pending',select:fields},'PATCH',{status:v.accept?'accepted':'declined'});
      if(!updated.length)return reply(res,409,{error:'Einladung wurde schon beantwortet.'});
      return reply(res,200,{ok:true,game:item.game,room:item.room,from_name:sender.name,accepted:v.accept});
    }
    if(action==='cancel'){
      if(typeof v.id!=='string'||!/^[0-9a-f-]{36}$/i.test(v.id))return reply(res,400,{error:'Ungültige Einladung.'});
      await invitations({id:'eq.'+v.id,from_id:'eq.'+me.id,status:'eq.pending'},'PATCH',{status:'cancelled'});
      return reply(res,200,{ok:true});
    }
    return reply(res,404,{error:'Nicht gefunden'});
  }

  if(url.pathname.startsWith('/api/friends/')) {
    if(req.method!=='POST')return reply(res,405,{error:'POST erforderlich'});
    let raw='';try {for await (const chunk of req) {raw+=chunk;if(raw.length>5000)throw Error('Too long');}}
    catch {return reply(res,413,{error:'Anfrage zu groß'});}
    let v={};try {v=JSON.parse(raw||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid');}
    catch {return reply(res,400,{error:'Ungültiges JSON'});}
    const action=url.pathname.slice('/api/friends/'.length);
    if (action==='register') {
      if (!allowedName(v.name)||!passwordOk(v.password)) return reply(res,400,{error:'Name: 3–28 Zeichen. Passwort: mindestens 10 Zeichen.'});
      if (await findName(v.name)) return reply(res,409,{error:'Spielername schon vergeben.'});
      const salt=crypto.randomBytes(16).toString('hex');
      const item={name:v.name.trim(),nick_key:key(v.name),code:'EF-'+crypto.randomBytes(9).toString('hex').toUpperCase(),password_salt:salt,password_hash:hash(v.password,salt)};
      let result;
      try { result=await accounts({select:'*'},'POST',item); }
      catch(e) { if(e.status===409)return reply(res,409,{error:'Spielername schon vergeben.'});throw e; }
      const a=result[0];return reply(res,200,{token:tokenFor(a),...await lists(a)});
    }
    if (action==='login') {
      const a=await findName(v.name);
      if(!a||typeof v.password!=='string'||v.password.length>128) return reply(res,401,{error:'Spielername oder Passwort falsch.'});
      const actual=Buffer.from(hash(v.password,a.password_salt),'hex');
      const stored=Buffer.from(a.password_hash||'','hex');
      if(stored.length!==actual.length||!crypto.timingSafeEqual(actual,stored)) return reply(res,401,{error:'Spielername oder Passwort falsch.'});
      return reply(res,200,{token:tokenFor(a),...await lists(a)});
    }
    const id=authId(req), a=id?await findId(id):null;
    if(!a) return reply(res,401,{error:'Bitte anmelden.'});
    if(action==='list')return reply(res,200,await lists(a));
    if(action==='request') {
      const b=await findCode(v.code);
      if(!b||b.id===a.id)return reply(res,404,{error:'Spieler nicht gefunden.'});
      const r=await relation(a.id,b.id);
      if(r) {
        if(r.status==='accepted')return reply(res,200,{...await lists(a),message:'Ihr seid bereits Freunde.'});
        if(r.requested_by===a.id)return reply(res,200,{...await lists(a),message:'Anfrage wurde bereits gesendet.'});
        return reply(res,409,{error:'Du hast bereits eine Anfrage von diesem Spieler. Bitte annehmen.'});
      }
      const current=await lists(a);
      const target=await lists(b);
      if(current.friends.length>=100||target.friends.length>=100)return reply(res,400,{error:'Freundesliste voll.'});
      const [player1_id,player2_id]=await pair(a.id,b.id);
      try {await relationships({},'POST',{player1_id,player2_id,requested_by:a.id,status:'pending'});}
      catch(e){if(e.status===409)return reply(res,409,{error:'Anfrage bereits vorhanden. Liste aktualisieren.'});throw e;}
      return reply(res,200,{...await lists(a),message:'Freundschaftsanfrage gesendet.'});
    }
    if(action==='respond') {
      if(typeof v.id!=='string'||!(/^[0-9a-f-]{36}$/i.test(v.id))||typeof v.accept!=='boolean') return reply(res,400,{error:'Ungültige Antwort.'});
      const r=(await relationships({id:'eq.'+v.id,status:'eq.pending',select:'*',limit:1}))[0];
      if(!r||r.requested_by===a.id||!([r.player1_id,r.player2_id].includes(a.id)))return reply(res,404,{error:'Anfrage nicht gefunden.'});
      if(v.accept) {
        const current=await lists(a);
        const other=await findId(r.requested_by);
        if(!other)return reply(res,404,{error:'Spieler nicht gefunden.'});
        if(current.friends.length>=100||(await lists(other)).friends.length>=100)return reply(res,400,{error:'Freundesliste voll.'});
        await relationships({id:'eq.'+r.id,status:'eq.pending'},'PATCH',{status:'accepted'});
      } else await relationships({id:'eq.'+r.id,status:'eq.pending'},'DELETE');
      return reply(res,200,{...await lists(a),message:v.accept?'Freundschaft bestätigt.':'Anfrage abgelehnt.'});
    }
    if(action==='remove') {
      const b=await findCode(v.code);
      if(!b)return reply(res,404,{error:'Spieler nicht gefunden.'});
      const [player1_id,player2_id]=await pair(a.id,b.id);
      await relationships({player1_id:'eq.'+player1_id,player2_id:'eq.'+player2_id},'DELETE');
      return reply(res,200,{...await lists(a),message:'Freund entfernt.'});
    }
    return reply(res,404,{error:'Nicht gefunden'});
  }
  if(req.method!=='GET'&&req.method!=='HEAD') {res.writeHead(405);return res.end();}
  const file=url.pathname==='/'?'/index.html':url.pathname;
  if(file==='/health')return reply(res,200,{status:'ok'});
  if(file==='/raum-schach.webp'||file==='/raum-dame.webp'){
    const art=path.join(__dirname,file.slice(1));
    if(!fs.existsSync(art)){res.writeHead(404);return res.end('Image missing');}
    res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD')return res.end();
    return fs.createReadStream(art).pipe(res);
  }
  if(file!=='/index.html'){res.writeHead(404);return res.end('Not found');}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(path.join(__dirname,'index.html')).on('error',()=>res.end('index.html missing')).pipe(res);
}
http.createServer((req,res)=>handle(req,res).catch(e=>{
  console.error('Request failed',e.status||'',e.message,e.details||'');
  if(!res.headersSent)reply(res,500,{error:'Serverfehler. Datenbankverbindung und Tabellen prüfen.'});else res.end();
})).listen(PORT,'0.0.0.0',()=>console.log('Arena v80 / Supabase + Matchmaking + Einladungen on port '+PORT));
