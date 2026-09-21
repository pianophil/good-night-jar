'use strict';
const skins={classic:{name:'Classic',b:'rgba(255,255,255,.78)',jt:'rgba(255,255,255,.14)',jb:'rgba(255,255,255,.04)',p1:'#ffd76a',p2:'#f2aa31',l1:'#ffe0a3',l2:'#d99f35',a:'rgba(255,93,143,.22)'},rose:{name:'Rosé',b:'rgba(255,226,238,.83)',jt:'rgba(255,175,208,.16)',jb:'rgba(255,255,255,.04)',p1:'#ffb5ce',p2:'#ff6fa2',l1:'#ffd7e5',l2:'#ee82a7',a:'rgba(255,93,143,.28)'},ocean:{name:'Ocean',b:'rgba(214,243,255,.84)',jt:'rgba(112,205,255,.17)',jb:'rgba(255,255,255,.04)',p1:'#7dd3fc',p2:'#3b82f6',l1:'#d5f2ff',l2:'#69b7ff',a:'rgba(59,130,246,.25)'},emerald:{name:'Emerald',b:'rgba(221,255,241,.84)',jt:'rgba(110,231,183,.17)',jb:'rgba(255,255,255,.04)',p1:'#86efac',p2:'#10b981',l1:'#d8ffe9',l2:'#48ce8c',a:'rgba(16,185,129,.24)'},midnight:{name:'Midnight',b:'rgba(218,219,255,.82)',jt:'rgba(101,90,220,.22)',jb:'rgba(15,15,40,.20)',p1:'#9297ff',p2:'#4f46e5',l1:'#c7c9ff',l2:'#686ee8',a:'rgba(79,70,229,.28)'},fire:{name:'Fire',b:'rgba(255,235,218,.86)',jt:'rgba(251,146,60,.16)',jb:'rgba(255,255,255,.04)',p1:'#fb923c',p2:'#ef4444',l1:'#ffd3ad',l2:'#f97316',a:'rgba(239,68,68,.25)'}};const accents={pink:['#ff5d8f','#ff91b0'],gold:['#e7aa2d','#ffd76a'],blue:['#3b82f6','#7dd3fc'],green:['#10b981','#86efac'],purple:['#7c3aed','#b69cff']};
const $ = id => document.getElementById(id);
const KEY='goodNightJarTogether_v2', LEGACY=['goodNightJarPremium_customName_v1','goodNightJarPremium_v1'];
const defaults={history:[],skin:'classic',accent:'pink',sound:true,vibrate:true,wifeName:''};
let local={...defaults}, account=null, mode='local', busy=false, plan='yearly', config={authReady:false,billingReady:false}, pendingInvite='', poll=null;
function normalize(value){
  if(!value || typeof value !== 'object' || !Array.isArray(value.history) || value.history.length>10000)throw Error('Ungültige Sicherung.');
  if(!value.history.every(x=>x && Number.isSafeInteger(x.ts) && x.ts>=0 && x.ts<=Date.now()))throw Error('Ungültige Einträge.');
  return {...defaults,history:value.history.map(x=>({id:typeof x.id==='string'?x.id:crypto.randomUUID(),ts:x.ts})),wifeName:typeof value.wifeName==='string'?value.wifeName.slice(0,40):'',skin:skins[value.skin]?value.skin:'classic',accent:accents[value.accent]?value.accent:'pink',sound:value.sound!==false,vibrate:value.vibrate!==false};
}
try{
  const own=localStorage.getItem(KEY);
  if(own)local=normalize(JSON.parse(own));
  else for(const key of LEGACY){const old=localStorage.getItem(key);if(old){local=normalize(JSON.parse(old));break}}
}catch(e){toast('Gespeicherte Daten konnten nicht gelesen werden. Bitte Sicherung prüfen.');}
try{pendingInvite=sessionStorage.getItem('gnj_invite')||''}catch{}
const fragment=new URLSearchParams(location.hash.slice(1));
if(fragment.has('invite')){pendingInvite=fragment.get('invite');try{sessionStorage.setItem('gnj_invite',pendingInvite)}catch{}history.replaceState(null,'',location.pathname+location.search)}
const loginToken=fragment.get('login');
if(loginToken)history.replaceState(null,'',location.pathname+location.search);
const current=()=>mode==='cloud'&&account?.jar?{...local,history:account.jar.history,wifeName:account.jar.name}:local;
const wife=()=>current().wifeName.trim()||'deinen Lieblingsmenschen';
function save(){try{localStorage.setItem(KEY,JSON.stringify(local));return true}catch{toast('Speichern nicht möglich. Bitte exportiere dein Glas.');return false}}
function toast(text){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3300)}
function message(title,subtitle){$('msg').textContent=title;const small=document.createElement('small');small.textContent=subtitle;$('msg').append(small)}
function open(id){const el=$(id);if(!el.open)el.showModal()}
function fmt(ts){return new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ts))}
function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}
async function api(path,data){
  let r;try{r=await fetch('/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20000)})}catch{throw Error('Keine Verbindung. Bitte erneut versuchen. Dein lokales Glas funktioniert offline.')}
  let value;try{value=await r.json()}catch{throw Error('Together ist auf dieser Adresse noch nicht aktiviert.')}
  if(!r.ok)throw Object.assign(Error(value.error||'Bitte erneut versuchen.'),{status:r.status});return value;
}
function applyDesign(){const s=skins[local.skin],r=document.documentElement.style;for(const [k,v] of Object.entries({'jar-border':s.b,'jar-top':s.jt,'jar-bottom':s.jb,pile1:s.p1,pile2:s.p2,lid1:s.l1,lid2:s.l2,aura:s.a,accent:accents[local.accent][0],accent2:accents[local.accent][1]}))r.setProperty('--'+k,v)}
function renderPickers(){
  $('skinGrid').replaceChildren();Object.entries(skins).forEach(([key,s])=>{const b=document.createElement('button');b.className='skin'+(local.skin===key?' active':'');b.textContent=s.name;b.onclick=()=>{local.skin=key;save();applyDesign();renderPickers()};$('skinGrid').append(b)});
  $('colors').replaceChildren();Object.entries(accents).forEach(([key,colors])=>{const b=document.createElement('button');b.className='color'+(local.accent===key?' active':'');b.setAttribute('aria-label','Farbe '+key);b.style.setProperty('--c',`linear-gradient(135deg,${colors.join(',')})`);b.onclick=()=>{local.accent=key;save();applyDesign();renderPickers()};$('colors').append(b)});
}
function render(){
  const state=current(),count=state.history.length,readonly=mode==='cloud'&&!account?.jar?.active;
  $('headlineText').textContent='Gute Nacht an '+wife()+' vergessen? Ein Euro für euer nächstes Date.';
  $('amount').textContent=count+' €';$('count').textContent=count+'x';$('fill').style.setProperty('--fill',Math.min(12+count*4.5,88)+'%');
  $('last').textContent=count?'zuletzt '+fmt(state.history.at(-1).ts):'bisher vorbildlich';
  $('addBtn').disabled=busy||readonly;$('undoBtn').disabled=busy||readonly||!count;$('resetBtn').disabled=busy||readonly||!count;$('saveNameBtn').disabled=busy||readonly;
  $('soundBtn').textContent=local.sound?'🔊 Sound an':'🔇 Sound aus';$('vibrateBtn').classList.toggle('on',local.vibrate);$('vibrateBtn').setAttribute('aria-pressed',String(local.vibrate));
  if(document.activeElement!==$('wifeName'))$('wifeName').value=state.wifeName;
  $('localMode').classList.toggle('active',mode==='local');$('cloudMode').classList.toggle('active',mode==='cloud');
  $('storageStatus').textContent=mode==='cloud'?(readonly?'Together pausiert · Lesen & Export weiter möglich':'Gemeinsames Glas · '+(account.jar.partnerConnected?'Ihr seid verbunden':'bereit für deine Einladung')):'Kostenlos · auf diesem Gerät gespeichert';
  $('coinPile').replaceChildren();const pos=[[10,8],[45,12],[80,6],[115,10],[144,7],[25,37],[60,42],[96,35],[130,40],[72,64],[110,62]];
  pos.slice(0,count).forEach(([x,y])=>{const c=document.createElement('div');c.className='coin';c.textContent='€';c.style.left=x+'px';c.style.bottom=y+'px';$('coinPile').append(c)});
  $('history').replaceChildren();if(!count){const e=document.createElement('div');e.className='empty';e.textContent='Noch keine Einträge. Perfekte Bilanz.';$('history').append(e)}
  state.history.slice(-30).reverse().forEach(x=>{const row=document.createElement('div');row.className='item';const label=document.createElement('span'),date=document.createElement('span');label.textContent='+1 € – Gute Nacht vergessen';date.textContent=fmt(x.ts);row.append(label,date);$('history').append(row)});
  const now=new Date(),days=[];for(let n=6;n>=0;n--){const d=new Date(now);d.setHours(0,0,0,0);d.setDate(d.getDate()-n);days.push(d)}
  const counts=days.map(d=>state.history.filter(x=>sameDay(new Date(x.ts),d)).length),max=Math.max(1,...counts);
  $('todayStat').textContent=counts[6]+' €';$('weekStat').textContent=counts.reduce((a,b)=>a+b,0)+' €';$('monthStat').textContent=state.history.filter(x=>{const d=new Date(x.ts);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()}).length+' €';
  $('chart').replaceChildren();days.forEach((d,i)=>{const wrap=document.createElement('div'),bar=document.createElement('div'),label=document.createElement('div');wrap.className='barWrap';bar.className='bar';bar.style.height=Math.max(3,counts[i]/max*90)+'px';label.className='day';label.textContent=['So','Mo','Di','Mi','Do','Fr','Sa'][d.getDay()];wrap.title=counts[i]+' €';wrap.append(bar,label);$('chart').append(wrap)});
  renderAccount();
}
function renderAccount(){
  const jar=account?.jar;$('signedOut').hidden=!!account;$('signedIn').hidden=!account;
  $('loginBtn').disabled=!config.authReady;$('checkoutBtn').disabled=!config.billingReady;
  $('launchNote').hidden=config.billingReady&&!config.testMode;
  $('launchNote').textContent=config.billingReady?'Testbetrieb: Es werden keine echten Zahlungen eingezogen.':'Together wird gerade vorbereitet. Dein lokales Glas ist schon kostenlos nutzbar.';
  $('plans').hidden=!!jar?.active||jar?.role==='partner';$('connectedBox').hidden=!jar;
  $('joinBox').hidden=!pendingInvite||!!jar;$('accountEmail').textContent=account?.user?.email||'';
  $('pairStatus').textContent=jar?.partnerConnected?'Ihr seid verbunden ♡':'Dein gemeinsames Glas';
  $('inviteBtn').hidden=!jar?.active||jar?.role!=='owner'||jar.partnerConnected;
  $('disconnectBtn').hidden=!jar?.partnerConnected;$('importLocalBtn').hidden=!jar?.active||!!jar?.history.length||!local.history.length;
  $('portalBtn').hidden=jar?.role==='partner';
  $('yearPlan').classList.toggle('selected',plan==='yearly');$('monthPlan').classList.toggle('selected',plan==='monthly');
}
function animate(){for(const [id,name] of [['dropcoin','go'],['jar','shake']]){$(id).classList.remove(name);void $(id).offsetWidth;$(id).classList.add(name)}
  if(local.vibrate&&navigator.vibrate)navigator.vibrate([25,35,20]);
  if(local.sound)try{const Audio=window.AudioContext||window.webkitAudioContext;if(Audio){const c=new Audio(),o=c.createOscillator(),g=c.createGain();o.frequency.value=650;g.gain.value=.06;o.connect(g);g.connect(c.destination);o.start();g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.2);o.stop(c.currentTime+.21);o.onended=()=>c.close()}}catch{}
}
async function refresh(){if(!account)return;try{account=await api('me');if(!account.jar&&mode==='cloud')mode='local';render()}catch(e){if(e.status===401){account=null;mode='local';render()}else if(mode==='cloud')$('storageStatus').textContent='Verbindung unterbrochen · angezeigter Stand zuletzt geladen'}}
async function change(action,payload,localAction){
  if(busy)return;busy=true;render();
  try{if(mode==='cloud'){account=await api('jar/'+action,{version:account.jar.version,...payload})}else{localAction();save()}
    if(action==='add'){animate();message('Ein Euro mehr für euer nächstes Date.','Nächstes Mal kurz „Gute Nacht ❤️“ an '+wife()+'.');toast('+1 € im Glas')}
  }catch(e){toast(e.message);if(e.status===409||e.status===402)await refresh()}
  finally{busy=false;render()}
}
$('addBtn').onclick=()=>change('add',{id:crypto.randomUUID()},()=>{if(local.history.length>=10000)throw Error('Bitte exportieren und das Glas leeren.');local.history.push({id:crypto.randomUUID(),ts:Date.now()})});
$('undoBtn').onclick=()=>{if(current().history.length)change('undo',{id:current().history.at(-1).id},()=>local.history.pop())};
$('resetBtn').onclick=()=>{if(confirm('Glas wirklich leeren? Exportiere es vorher, wenn du die Historie behalten möchtest.'))change('reset',{confirm:true},()=>{local.history=[]})};
$('saveNameBtn').onclick=()=>{const name=$('wifeName').value.trim().slice(0,40);change('name',{name},()=>{local.wifeName=name})};
$('wifeName').onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();$('saveNameBtn').click()}};
$('designBtn').onclick=()=>$('designPanel').classList.toggle('open');$('soundBtn').onclick=()=>{local.sound=!local.sound;save();render()};$('vibrateBtn').onclick=()=>{local.vibrate=!local.vibrate;save();render()};
for(const b of document.querySelectorAll('.tab'))b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.panel[id]').forEach(x=>x.classList.remove('active'));b.classList.add('active');$(b.dataset.tab).classList.add('active')};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>b.closest('dialog').close();
for(const id of ['accountBtn','upgradeBtn'])$(id).onclick=()=>open('accountDialog');
$('cloudMode').onclick=()=>{if(busy)return;if(account?.jar){mode='cloud';render();refresh()}else open('accountDialog')};$('localMode').onclick=()=>{if(!busy){mode='local';render()}};
$('backupBtn').onclick=()=>open('backupDialog');$('privacyBtn').onclick=()=>open('privacyDialog');
async function action(fn){if(busy)return;busy=true;$('accountFeedback').textContent='Einen Moment …';try{await fn();$('accountFeedback').textContent=''}catch(e){$('accountFeedback').textContent=e.message}finally{busy=false;render()}}
$('loginForm').onsubmit=ev=>{ev.preventDefault();action(async()=>{await api('auth/request',{email:$('emailInput').value});$('loginForm').hidden=true;const p=document.createElement('p');p.textContent='Dein Anmeldelink ist unterwegs. Bitte prüfe auch den Spamordner.';$('signedOut').append(p)})};
$('yearPlan').onclick=()=>{plan='yearly';renderAccount()};$('monthPlan').onclick=()=>{plan='monthly';renderAccount()};
$('checkoutBtn').onclick=()=>action(async()=>{if(!$('termsCheck').checked)throw Error('Bitte zuerst die Bedingungen bestätigen.');const result=await api('checkout',{plan,acceptedTerms:true});location.assign(result.url)});
$('portalBtn').onclick=()=>action(async()=>{const result=await api('portal',{});location.assign(result.url)});
$('refreshBtn').onclick=()=>action(async()=>{account=await api('billing/refresh',{});if(account.jar){mode='cloud';toast('Gemeinsames Glas geladen')}else toast('Zahlung noch nicht bestätigt. Bitte kurz warten.')});
$('inviteBtn').onclick=()=>action(async()=>{const result=await api('invite',{});$('inviteUrl').value=result.url;$('inviteOutput').hidden=false});
$('copyInviteBtn').onclick=async()=>{try{await navigator.clipboard.writeText($('inviteUrl').value);toast('Einladungslink kopiert')}catch{$('inviteUrl').select();toast('Bitte den markierten Link kopieren')}};
$('joinBtn').onclick=()=>action(async()=>{account=await api('join',{token:pendingInvite});pendingInvite='';try{sessionStorage.removeItem('gnj_invite')}catch{}mode='cloud';$('accountDialog').close();toast('Ihr seid verbunden ♡')});
$('importLocalBtn').onclick=()=>{if(confirm('Deinen lokalen Stand in das neue gemeinsame Glas kopieren? Beide können ihn dann sehen.'))action(async()=>{account=await api('jar/import',{version:account.jar.version,history:local.history});mode='cloud';toast('Stand übernommen')})};
$('disconnectBtn').onclick=()=>{if(confirm('Verbindung trennen? Die eingeladene Person verliert den Zugang. Das Glas bleibt bei der Person mit dem Abo.'))action(async()=>{account=await api('disconnect',{confirm:true});if(!account.jar)mode='local';toast('Verbindung getrennt')})};
$('logoutBtn').onclick=()=>action(async()=>{await api('auth/logout',{});account=null;mode='local';$('inviteOutput').hidden=true;$('inviteUrl').value='';$('loginForm').hidden=false;toast('Abgemeldet')});
$('deleteAccountBtn').onclick=()=>{if(confirm('Konto endgültig löschen? Ein eigenes Abo wird beendet und dein gemeinsames Glas gelöscht. Als eingeladene Person entfernst du nur deinen Zugang. Bitte vorher exportieren.'))action(async()=>{await api('account/delete',{confirm:'DELETE'});account=null;mode='local';$('accountDialog').close();toast('Konto gelöscht')})};
function download(value){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='good-night-jar-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('exportBtn').onclick=async()=>{try{const cloud=mode==='cloud'?await api('export'):null;download({format:'good-night-jar',version:2,exportedAt:new Date().toISOString(),scope:mode,state:current(),cloud});$('backupFeedback').textContent='Sicherung wurde erstellt.'}catch(e){$('backupFeedback').textContent=e.message}};
$('importFile').onchange=async ev=>{const file=ev.target.files[0];if(!file)return;try{if(file.size>1024*1024)throw Error('Datei zu groß.');const value=JSON.parse(await file.text()),next=normalize(value.state||value);if(confirm('Lokalen Stand durch diese Sicherung ersetzen?')){local=next;mode='local';save();applyDesign();renderPickers();render();$('backupFeedback').textContent='Lokales Glas wiederhergestellt.'}}catch(e){$('backupFeedback').textContent=e.message}finally{ev.target.value=''}};
$('shareBtn').onclick=async()=>{const url=location.origin+location.pathname;try{if(navigator.share)await navigator.share({title:'Good Night Jar',text:'Gute Nacht vergessen? Ein Euro ins Glas für euer nächstes Date. 🌙',url});else{await navigator.clipboard.writeText(url);toast('App-Link kopiert')}}catch(e){if(e.name!=='AbortError')toast('Teile die Adresse dieser App.')}};
window.addEventListener('storage',event=>{if(event.key===KEY&&event.newValue){try{local=normalize(JSON.parse(event.newValue));applyDesign();renderPickers();render()}catch{}}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy)refresh()});
window.addEventListener('online',()=>refresh());
if(!(window.matchMedia('(display-mode: standalone)').matches||navigator.standalone))$('installBanner').classList.add('show');
applyDesign();renderPickers();render();
(async()=>{
  try{config=await api('config');for(const [id,key] of [['termsLink','terms'],['privacyLink','privacy'],['fullPrivacyLink','privacy'],['imprintLink','imprint']])if(config[key]){const u=new URL(config[key]);if(u.protocol==='https:'){$(id).href=u.href;$(id).hidden=false}}
    if(loginToken){account=await api('auth/verify',{token:loginToken});open('accountDialog')}
    else{try{account=await api('me')}catch(e){if(e.status!==401)throw e}}
    if(account?.jar)mode='cloud';
    if(account&&new URLSearchParams(location.search).get('payment')==='success'){account=await api('billing/refresh',{});if(account.jar)mode='cloud';open('accountDialog')}
    if(pendingInvite)open('accountDialog');
  }catch(e){if(loginToken){open('accountDialog');$('accountFeedback').textContent=e.message}}
  render();poll=setInterval(()=>{if(account&&!document.hidden&&!busy)refresh()},10000);
})();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
