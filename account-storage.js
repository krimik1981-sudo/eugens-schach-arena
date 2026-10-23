'use strict';
const crypto=require('node:crypto');
const URL_BASE=process.env.SUPABASE_URL;
const KEY=process.env.SUPABASE_SECRET_KEY;
const ready=()=>Boolean(URL_BASE&&KEY);
function digest(x){return crypto.createHash('sha256').update(x).digest('hex')}
function pwHash(password,salt){return crypto.scryptSync(password,salt,64).toString('hex')}
async function rest(table,method='GET',query='',body,extra={}){
 if(!ready())throw Object.assign(Error('Аккаунты ещё не подключены к Supabase. Проверь настройки Render.'),{status:503});
 const url=URL_BASE.replace(/\/$/,'')+'/rest/v1/'+table+(query?'?'+query:'');
 const headers={'apikey':KEY,'Authorization':'Bearer '+KEY,'Content-Type':'application/json',...extra};
 const response=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let out;try{out=JSON.parse(text)}catch{out=text}
 if(!response.ok){console.error('DB request failure',table,response.status);throw Object.assign(Error('Ошибка базы данных. Проверь SQL и настройки Supabase.'),{status:503})}
 return out;
}
const eq=s=>encodeURIComponent('eq.'+s);
function normalize(n){return String(n||'').trim().normalize('NFKC')}
function validNick(n){return n.length>=3&&n.length<=24&&/^[\p{L}\p{N}_ -]+$/u.test(n)}
function validPassword(s){return typeof s==='string'&&s.length>=10&&s.length<=128}
async function playerByNick(n){const rows=await rest('chess_players','GET','nick_key='+eq(n.toLocaleLowerCase('und'))+'&select=id,nick,nick_key,password_hash,password_salt&limit=1');return rows[0]||null}
function sessionToken(){return crypto.randomBytes(32).toString('base64url')}
async function signup(n,password){const nick=normalize(n);if(!validNick(nick)||!validPassword(password))throw Object.assign(Error('Ник: 3–24 буквы/цифры. Пароль: минимум 10 символов.'),{status:400});
 if(await playerByNick(nick))throw Object.assign(Error('Этот ник уже занят.'),{status:409});
 const salt=crypto.randomBytes(16).toString('hex');let rows;
 try{rows=await rest('chess_players','POST','select=id,nick',[{nick,nick_key:nick.toLocaleLowerCase('und'),password_salt:salt,password_hash:pwHash(password,salt)}],{'Prefer':'return=representation'})}catch(e){throw e}
 return makeSession(rows[0]);
}
async function login(n,password){const nick=normalize(n);if(!validNick(nick)||!validPassword(password))throw Object.assign(Error('Неверный ник или пароль.'),{status:401});const p=await playerByNick(nick);
 if(!p)throw Object.assign(Error('Неверный ник или пароль.'),{status:401});
 const a=Buffer.from(pwHash(password,p.password_salt),'hex'),b=Buffer.from(p.password_hash,'hex');
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Object.assign(Error('Неверный ник или пароль.'),{status:401});return makeSession(p);
}
async function makeSession(p){const token=sessionToken();await rest('chess_sessions','POST','',[{player_id:p.id,token_hash:digest(token),expires_at:new Date(Date.now()+180*86400000).toISOString()}]);return {token,player:{id:p.id,nick:p.nick}}}
async function auth(token){if(typeof token!=='string'||token.length<30||token.length>200)throw Object.assign(Error('Сначала войди в аккаунт.'),{status:401});
 const rows=await rest('chess_sessions','GET','token_hash='+eq(digest(token))+'&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=player_id,expires_at&limit=1');if(!rows.length)throw Object.assign(Error('Сессия закончилась. Войди снова.'),{status:401});
 const ps=await rest('chess_players','GET','id='+eq(rows[0].player_id)+'&select=id,nick&limit=1');if(!ps.length)throw Object.assign(Error('Аккаунт не найден.'),{status:401});return ps[0];
}
async function logout(token){if(typeof token==='string'&&token.length>30)await rest('chess_sessions','DELETE','token_hash='+eq(digest(token)))}
async function invite(from,nick,room){const other=await playerByNick(normalize(nick));if(!other)throw Object.assign(Error('Игрок с таким ником не найден.'),{status:404});if(other.id===from.id)throw Object.assign(Error('Нельзя пригласить самого себя.'),{status:400});if(!/^EUGEN-[A-Z0-9-]{6,50}$/.test(room))throw Object.assign(Error('Некорректный код комнаты.'),{status:400});
 const data=await rest('chess_invites','POST','select=id,created_at',[{from_id:from.id,to_id:other.id,room_code:room,status:'pending',expires_at:new Date(Date.now()+20*60000).toISOString()}],{'Prefer':'return=representation'});return data[0];
}
async function inbox(p){const rows=await rest('chess_invites','GET','to_id='+eq(p.id)+'&status=eq.pending&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=id,from_id,room_code,created_at&order=created_at.desc&limit=15');const ids=[...new Set(rows.map(x=>x.from_id))];let names=[];if(ids.length)names=await rest('chess_players','GET','id=in.('+ids.join(',')+')&select=id,nick');const by=new Map(names.map(x=>[x.id,x.nick]));return rows.map(x=>({id:x.id,from:by.get(x.from_id)||'Игрок',room:x.room_code}))}
async function accept(p,id){if(!/^[a-f0-9-]{36}$/i.test(String(id||'')))throw Object.assign(Error('Неверное приглашение.'),{status:400});const rows=await rest('chess_invites','PATCH','id='+eq(id)+'&to_id='+eq(p.id)+'&status=eq.pending&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=id,room_code',{status:'accepted'},{'Prefer':'return=representation'});if(!rows.length)throw Object.assign(Error('Приглашение истекло.'),{status:404});return rows[0]}
module.exports={ready,signup,login,auth,logout,invite,inbox,accept};
