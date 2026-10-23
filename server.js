'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const accounts = require('./account-storage');
const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const rooms = new Map();
const validClient = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{12,70}$/.test(x);
const validRoom = x => typeof x === 'string' && /^EUGEN-[A-F0-9]{14}$/.test(x);
const safeTime = x => [3,5,10,15].includes(Number(x)) ? Number(x) : 10;
const fresh = r => Date.now() - r.lastHost < 45000 && (!r.guest || Date.now() - r.lastGuest < 45000);
function clean() { for (const [code,r] of rooms) if (!fresh(r)) rooms.delete(code); }
setInterval(clean, 10000).unref();
function json(res, code, body) {res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
function readBody(req) {return new Promise((resolve, reject)=>{let parts=[],n=0; req.on('data',d=>{n+=d.length;if(n>4096){reject(Error('Too large'));req.destroy();return}parts.push(d)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString()||'{}'))}catch(e){reject(e)}});req.on('error',reject)});}
async function api(req,res) {
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 let data;try{data=await readBody(req)}catch{return json(res,400,{error:'Invalid request'})}
 if(req.url.startsWith('/api/account/') || req.url.startsWith('/api/friends/')) {
   try {
     let out;
     if(req.url==='/api/account/register') out=await accounts.signup(data.nick,data.password);
     else if(req.url==='/api/account/login') out=await accounts.login(data.nick,data.password);
     else if(req.url==='/api/account/me') out={player:await accounts.auth(data.token)};
     else if(req.url==='/api/account/logout') {await accounts.logout(data.token);out={ok:true}}
     else {const player=await accounts.auth(data.token);
       if(req.url==='/api/friends/invite') out=await accounts.invite(player,data.nick,data.room);
       else if(req.url==='/api/friends/inbox') out={invites:await accounts.inbox(player)};
       else if(req.url==='/api/friends/accept') out=await accounts.accept(player,data.id);
       else return json(res,404,{error:'Unknown endpoint'});
     }
     return json(res,200,out);
   }catch(e){return json(res,e.status||500,{error:e.message||'Ошибка аккаунта'})}
 }
 if(!validClient(data.clientId))return json(res,400,{error:'Invalid player identifier'});
 clean();
 if(req.url==='/api/match/join') {
   const time=safeTime(data.time);
   for(const [code,r] of rooms) if(r.host===data.clientId || r.guest===data.clientId){
      return json(res,200,{role:r.host===data.clientId?'host':'guest',room:code,time:r.time,ready:r.ready,found:true});
   }
   const waiting=[...rooms.values()].filter(r=>r.ready&&!r.guest&&r.time===time&&fresh(r)).sort((a,b)=>a.created-b.created)[0];
   if(waiting){waiting.guest=data.clientId;waiting.lastGuest=Date.now();return json(res,200,{role:'guest',room:waiting.room,time:waiting.time,ready:true,found:true})}
   let room;do{room='EUGEN-'+crypto.randomBytes(7).toString('hex').toUpperCase()}while(rooms.has(room));
   rooms.set(room,{room,host:data.clientId,guest:null,ready:false,time,created:Date.now(),lastHost:Date.now(),lastGuest:0});
   return json(res,200,{role:'host',room,time,ready:false,found:false});
 }
 if(!validRoom(data.room))return json(res,400,{error:'Invalid room'});
 const r=rooms.get(data.room);
 if(req.url==='/api/match/leave') {
   if(r&&(r.host===data.clientId||r.guest===data.clientId))rooms.delete(data.room);
   return json(res,200,{ok:true});
 }
 if(!r||!(r.host===data.clientId||r.guest===data.clientId))return json(res,404,{error:'Room expired or not yours'});
 if(req.url==='/api/match/heartbeat') {
   if(r.host===data.clientId){r.lastHost=Date.now();if(data.ready)r.ready=true}else r.lastGuest=Date.now();
   return json(res,200,{ok:true,ready:r.ready,occupied:!!r.guest});
 }
 return json(res,404,{error:'No such endpoint'});
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.webmanifest':'application/manifest+json; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 let url;try{url=new URL(req.url,'http://localhost')}catch{return json(res,400,{error:'Bad URL'})}
 if(url.pathname.startsWith('/api/')) {req.url=url.pathname;return api(req,res)}
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end()}
 const pathname=url.pathname==='/'?'/index.html':url.pathname;
 if(!/^\/(?:index\.html|[a-zA-Z0-9_-]+\.(?:css|js|png|svg|webp|ico|webmanifest))$/.test(pathname) || pathname==='/server.js' || pathname==='/server.test.js') {res.writeHead(404);return res.end('Not found')}
 const filename=path.resolve(ROOT,'.'+decodeURIComponent(pathname));
 if(!filename.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end()}
 fs.stat(filename,(err,stat)=>{if(err||!stat.isFile()){res.writeHead(404);return res.end('Not found')}
   res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
   if(req.method==='HEAD')return res.end();fs.createReadStream(filename).pipe(res);
 });
});
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log('Eugens Schach Arena:',PORT));
module.exports={server,rooms,clean};
