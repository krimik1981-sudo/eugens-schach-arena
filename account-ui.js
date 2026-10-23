/* Eugens Schach Arena 4.9: independent persistent login and invite by nick */
(()=>{'use strict';
 const $=id=>document.getElementById(id);
 const menu=$('liveMenu');
 const profileHost=document.querySelector('#profilesView .profile-panel');
 if(!menu||!profileHost)return;
 const tokenKey='eugens_schach_login_v49';let token='',player=null,busy=false,polling=false;
 const panel=document.createElement('section');panel.className='chess-account card';panel.innerHTML=`
  <h2>🔐 Mein Schach-Konto</h2>
  <p id="chessAccountStatus" role="status">Melde dich einmal an. Auf diesem Gerät bleibst du angemeldet.</p>
  <div id="chessAuthFields"><label>Dein Spielername <input id="chessNick" autocomplete="username" maxlength="24" placeholder="z. B. Eugen"></label>
  <label>Passwort <input id="chessPassword" type="password" autocomplete="current-password" minlength="10" maxlength="128" placeholder="Mindestens 10 Zeichen"></label>
  <div class="chess-auth-actions"><button id="chessLogin" type="button">Anmelden</button><button id="chessRegister" type="button">Registrieren</button></div></div>
  <div id="chessLoggedIn" hidden><strong id="chessWho"></strong> <button type="button" id="chessLogout">Abmelden</button></div>
  <div id="chessFriendArea" hidden><h3>👥 Einen Freund herausfordern</h3>
   <p>Dein Freund meldet sich auf seinem eigenen Gerät an. Gib nur seinen Spielernamen ein.</p>
   <div class="chess-auth-actions"><input id="chessFriendNick" maxlength="24" placeholder="Spielername des Freundes"><button type="button" id="chessInvite">Einladen</button></div>
   <p id="chessFriendStatus" role="status"></p>
   <div id="chessInvitations"></div>
  </div>`;
 // Account belongs in the profile screen, not the live matchmaking screen.
 panel.id='chessAccountPanel';
 const profileIdentity=profileHost.querySelector('.profile-identity');
 profileHost.insertBefore(panel,profileIdentity||profileHost.firstChild);
 const style=document.createElement('style');style.textContent=`
  .chess-account{box-sizing:border-box;margin:16px 0 22px;width:100%;max-width:100%;border:1px solid #4083a2;background:#112d49;border-radius:14px;padding:17px;color:#eaf6ff}
  .chess-account h2{color:#f5cf74;margin:0 0 8px}.chess-account h3{margin:15px 0 6px}
  .chess-account input{min-height:43px;max-width:100%;padding:9px;border-radius:8px;background:#0b2039;color:white;border:1px solid #6487a7}
  .chess-account label{display:block;margin:10px 0}.chess-account label input{display:block;width:100%;margin-top:4px}
  .chess-auth-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:10px}.chess-auth-actions input{flex:1;min-width:140px}
  .chess-account button{min-height:43px;cursor:pointer}.chess-invite{padding:10px;background:#203e5b;border-radius:9px;margin:8px 0}
  .chess-invite button{margin-left:8px}
  #chessAccountStatus,#chessFriendStatus{overflow-wrap:anywhere;color:#cde5f3;line-height:1.5}
  @media(max-width:650px){.chess-account{padding:12px}.chess-auth-actions button{flex:1}}
 `;document.head.appendChild(style);
 async function api(endpoint,body){const r=await fetch('/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let out;try{out=await r.json()}catch{throw Error('Server antwortet nicht. Bitte erneut versuchen.')};if(!r.ok)throw Error(out.error||'Verbindung fehlgeschlagen');return out}
 const message=t=>{$('chessAccountStatus').textContent=t};const friendMessage=t=>{$('chessFriendStatus').textContent=t};
 function render(){const logged=!!player;$('chessAuthFields').hidden=logged;$('chessLoggedIn').hidden=!logged;$('chessFriendArea').hidden=!logged;
 $('chessWho').textContent=logged?'✅ Angemeldet: '+player.nick:'';
 if(logged)message('Automatisch angemeldet auf diesem Gerät. Dein Konto funktioniert auch auf anderen Geräten.');}
 async function setLogin(mode){if(busy)return;busy=true;const nick=$('chessNick').value.trim(),password=$('chessPassword').value;
 try{const res=await api('account/'+mode,{nick,password});token=res.token;player=res.player;localStorage.setItem(tokenKey,token);$('chessPassword').value='';render();friendMessage('Du kannst einem Freund eine Einladung senden.');await inbox()}
 catch(e){message('⚠️ '+e.message)}finally{busy=false}}
 $('chessLogin').addEventListener('click',()=>setLogin('login'));$('chessRegister').addEventListener('click',()=>setLogin('register'));
 $('chessLogout').addEventListener('click',async()=>{const t=token;token='';player=null;localStorage.removeItem(tokenKey);render();message('Du bist abgemeldet.');$('chessInvitations').replaceChildren();try{await api('account/logout',{token:t})}catch{}});
 async function roomAfterCreate(){const el=$('liveRoomCode');const previous=el?.textContent?.trim();$('liveCreate').click();const until=Date.now()+16000;
 while(Date.now()<until){const code=el?.textContent?.trim()||'';if(code!==previous && /^EUGEN-[A-Z0-9-]{6,50}$/.test(code) && !$('liveGame').hidden)return code;await new Promise(r=>setTimeout(r,350))}
 throw Error('Raum wurde nicht erstellt. Prüfe die Internetverbindung.');}
 $('chessInvite').onclick=async()=>{if(busy||!token)return;busy=true;const nick=$('chessFriendNick').value.trim();friendMessage('Erstelle Raum und sende Einladung …');
 try{const room=await roomAfterCreate();await api('friends/invite',{token,nick,room});friendMessage('✅ Einladung an '+nick+' gesendet. Bitte lasse diesen Tisch geöffnet.')}
 catch(e){friendMessage('⚠️ '+e.message)}finally{busy=false}};
 async function inbox(){if(!token||polling)return;polling=true;try{
 const {invites}=await api('friends/inbox',{token});const el=$('chessInvitations');el.replaceChildren();
 if(invites.length){const h=document.createElement('strong');h.textContent='📩 Einladungen';el.append(h)}
 for(const invite of invites){const row=document.createElement('div');row.className='chess-invite';const name=document.createElement('span');name.textContent=invite.from+' fordert dich heraus! ';const btn=document.createElement('button');btn.type='button';btn.textContent='♟️ Annehmen';btn.onclick=async()=>{btn.disabled=true;try{const answer=await api('friends/accept',{token,id:invite.id});$('liveCodeInput').value=answer.room;$('liveJoin').click();friendMessage('Verbinde mit '+invite.from+' …')}catch(e){friendMessage('⚠️ '+e.message);btn.disabled=false}};row.append(name,btn);el.append(row)}
 }catch(e){friendMessage('⚠️ '+e.message)}finally{polling=false}}
 setInterval(()=>{if(player&&(!menu.hidden||!$('profilesView').hidden))inbox()},4500);
 async function autoLogin(){try{token=localStorage.getItem(tokenKey)||'';if(!token)return render();const result=await api('account/me',{token});player=result.player;render();await inbox()}
 catch(e){token='';player=null;localStorage.removeItem(tokenKey);render();message('Bitte anmelden. '+e.message)}}autoLogin();
})();
