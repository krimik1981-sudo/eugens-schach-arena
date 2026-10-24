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
  let resp;
  try { resp = await fetch(url,{method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(12000)}); }
  catch (e) { throw new DatabaseError('Supabase nicht erreichbar.',503,e.message); }
  let data; try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) throw new DatabaseError('Datenbankabfrage fehlgeschlagen.',resp.status,data);
  return data || [];
}
const accounts = (params, method='GET', body) => db('arena_accounts',method,params,body);
const relationships = (params, method='GET', body) => db('arena_friendships',method,params,body);
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
      return reply(res,200,{room,role:item.host===data.clientId?'host':'guest'});
    const time=kind==='chess'?Number(data.time)||0:0;
    const waiting=[...queue.entries()].find(([room,item])=>item.ready&&!item.guest && (kind==='dame'||item.time===time));
    if(waiting) {
      const [room,item]=waiting;item.guest=data.clientId;item.updated=now;
      return reply(res,200,{room,role:'guest'});
    }
    let room;
    do {room=(dame?'d':'c')+crypto.randomBytes(14).toString('hex')}while(queue.has(room));
    queue.set(room,{host:data.clientId,guest:null,ready:false,time,updated:now});
    return reply(res,200,{room,role:'host'});
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
async function handle(req,res) {
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/match/') || url.pathname.startsWith('/api/dame-match/'))return matchAction(req,res,url);
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
  if(file!=='/index.html'){res.writeHead(404);return res.end('Not found');}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(path.join(__dirname,'index.html')).on('error',()=>res.end('index.html missing')).pipe(res);
}
http.createServer((req,res)=>handle(req,res).catch(e=>{
  console.error('Request failed',e.status||'',e.message,e.details||'');
  if(!res.headersSent)reply(res,500,{error:'Serverfehler. Datenbankverbindung und Tabellen prüfen.'});else res.end();
})).listen(PORT,'0.0.0.0',()=>console.log('Arena v75 / Supabase + Matchmaking on port '+PORT));
