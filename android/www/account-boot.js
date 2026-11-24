'use strict';
(()=>{
 const desktop=typeof window.duo?.onFriendMsg==='function',platform=desktop?'desktop':'phone';
 const prefix=desktop?'duo.':'aloc.';
 const read=(k,d)=>{const raw=localStorage.getItem(prefix+k);return raw==null?d:(JSON.parse(raw)??d)};
 const write=(k,v)=>localStorage.setItem(prefix+k,JSON.stringify(v));
 const b64=bytes=>{let text='';for(const b of bytes)text+=String.fromCharCode(b);return btoa(text)};
 const unb64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
 const api={
  backup:sid=>window.accountRecovery.backup(sid),
  info:async()=>{for(let attempt=0;attempt<24;attempt++){const result=desktop?await duo.friendsInfo():await alo.friendsInfo();if(result?.id)return result;await new Promise(r=>setTimeout(r,400))}throw Error('Канал друзей не запустился')},
  invite:()=>desktop?duo.fcMake(read('nick','Без имени')):alo.fcMake({nick:read('nick','Без имени')}),
  parse:code=>desktop?duo.fcParse(code):alo.fcParse({code}),
  use:code=>desktop?duo.fcUse(code,read('nick','Без имени')):alo.fcUse({code,nick:read('nick','Без имени')}),
  accept:async id=>{const r=desktop?await duo.fcAccept(id,read('nick','Без имени')):await alo.fcAccept({id,nick:read('nick','Без имени')});return r===true||r?.ok===true},
  pending:()=>desktop?duo.fcPending():alo.fcPending(),
  remove:id=>desktop?duo.friendsRemove(id):alo.friendsRemove({id}),
  cancelLink:id=>desktop?duo.fcCancel(id):alo.fcCancel({id}),
  send:(id,msg)=>desktop?duo.friendsSend(id,msg):alo.friendsSend({id,msg}),
  now:()=>Date.now(),random:()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join(''),
  hash:async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join(''),
  encode:v=>b64(new TextEncoder().encode(JSON.stringify(v))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),
  decode:v=>JSON.parse(new TextDecoder().decode(unb64(v.replace(/-/g,'+').replace(/_/g,'/')))),
  read:async()=>{const r=desktop?await duo.accountLabRead():await alo.accountLabRead();if(r?.ok!==true)throw Error(r?.error||'Не удалось прочитать данные аккаунта');if(r.record){if(r.record.v!==1)throw Error('Неизвестная версия данных прототипа');return r.record}const raw=localStorage.getItem('accountLab.record.v1');if(raw==null)return {};const record=JSON.parse(raw);if(record.v!==1)throw Error('Неизвестная версия данных прототипа');await api.write(record);return record},
  write:async value=>{const json=JSON.stringify(value);const r=desktop?await duo.accountLabWrite(json):await alo.accountLabWrite({json});if(r?.ok!==true)throw Error(r?.error||'Не удалось сохранить данные аккаунта');localStorage.removeItem('accountLab.record.v1')},
  snapshot:async info=>{
   let av=null;if(desktop){const raw=await duo.avatarMine();if(raw)av={mime:raw.mime,b64:b64(new Uint8Array(raw.bytes))}}else{const raw=read('av.me',null);if(raw)av={mime:raw.mime,b64:raw.b64}}
   const full=desktop?await duo.accountLabInfo():await alo.accountLabInfo();if(full.id!==info.id)throw Error('Не удалось прочитать контакты устройства');
   return {device:{id:info.id,kind:platform,name:read('accountLab.deviceName',desktop?'Мой ПК':'Мой телефон')},profile:{nick:read('nick','Без имени'),avatar:av},friends:full.list||[],data:window.accountLab?.engine.account?await window.accountLabData.snapshot():undefined,dataSummary:await window.accountLabData.summary(),accountId:window.accountLab?.engine.account?.id||null};
  },
  initialSync:async account=>{
   const self=(await api.info()).id,initial=AccountSync.genesis(account),base=AccountSync.semantic(AccountSync.materialize(initial,account));
   const current={...base,data:await window.accountLabData.snapshot()},state=AccountSync.capture(initial,base,current,self,account),value=AccountSync.materialize(state,account);
   return {account:value,sync:{v:1,state,observed:AccountSync.semantic(value),hash:await api.hash(AccountSync.stable(state)),ackedHash:null,ackedAt:0}};
  },
  apply:async account=>{
   const info=await api.info();
   for(const f of account.friends){if(f.id===info.id)continue;const r=desktop?await duo.friendsAdd(f):await alo.friendsAdd(f);if(r===false||r?.ok===false)throw Error('Не удалось сохранить контакт');if(f.renamed){if(desktop)await duo.accountLabRename(f.id,f.nick);else await alo.friendsRename({id:f.id,nick:f.nick})}}
   write('nick',account.profile.nick);
   const inp=document.getElementById('nick');if(inp)inp.value=account.profile.nick;
   if(typeof S!=='undefined')S.nick=account.profile.nick;
   if(desktop)await duo.friendsNick(account.profile.nick);else await alo.friendsNick({nick:account.profile.nick});
   const av=account.profile.avatar;
   if(desktop){if(av)await duo.avatarSetMine(unb64(av.b64),av.mime);else await duo.avatarClearMine();}
   else{if(av){const hash=(await api.hashBytes(unb64(av.b64))).slice(0,16);write('av.me',{...av,hash});if(typeof myAvatar!=='undefined')myAvatar={...av,hash}}else{localStorage.removeItem(prefix+'av.me');if(typeof myAvatar!=='undefined')myAvatar=null}if(typeof refreshAvatars==='function')refreshAvatars();}
  },
  applySynced:async account=>{
   await window.accountLabData.apply(account.data||{});
   const prior=engine.account,info=await api.info(),full=desktop?await duo.accountLabInfo():await alo.accountLabInfo(),ids=new Set(account.devices.map(d=>d.id)),desired=new Map(account.friends.map(f=>[f.id,f])),existing=new Map((full.list||[]).map(f=>[f.id,f])),previous=new Map((prior?.friends||[]).map(f=>[f.id,f]));
   for(const f of full.list||[])if(!ids.has(f.id)&&previous.has(f.id)&&!desired.has(f.id))await api.remove(f.id);
   for(const f of account.friends){const old=existing.get(f.id),prev=previous.get(f.id),changed=!prev||prev.nick!==f.nick||!!prev.renamed!==!!f.renamed,nativeChanged=prev?(!old||old.nick!==prev.nick||!!old.renamed!==!!prev.renamed):!!old;if(changed&&!nativeChanged&&(!old||old.nick!==f.nick||!!old.renamed!==!!f.renamed)){const result=desktop?await duo.accountLabUpsert(f):await alo.accountLabUpsert(f);if(result===false||result?.ok===false)throw Error('Не удалось сохранить изменение контакта')}}
   if(prior?.profile.nick!==account.profile.nick&&read('nick','Без имени')===prior?.profile.nick){write('nick',account.profile.nick);const input=document.getElementById('nick');if(input)input.value=account.profile.nick;if(typeof S!=='undefined')S.nick=account.profile.nick;if(desktop)await duo.friendsNick(account.profile.nick);else await alo.friendsNick({nick:account.profile.nick});const me=document.getElementById('meName');if(me)me.textContent=account.profile.nick;const initial=document.getElementById('meInitial');if(initial)initial.textContent=account.profile.nick[0]?.toUpperCase()||'?'}
   const raw=await api.snapshot(info),before=raw.profile.avatar,av=account.profile.avatar;
   if(JSON.stringify(prior?.profile.avatar)!==JSON.stringify(av)&&JSON.stringify(before)===JSON.stringify(prior?.profile.avatar)){
    if(desktop){if(av)await duo.avatarSetMine(unb64(av.b64),av.mime);else await duo.avatarClearMine();if(typeof loadMyAvatar==='function')await loadMyAvatar()}
    else{if(typeof myAvatar!=='undefined'&&myAvatar?.url)URL.revokeObjectURL(myAvatar.url);if(av){const hash=(await api.hashBytes(unb64(av.b64))).slice(0,16);write('av.me',{...av,hash});if(typeof myAvatar!=='undefined')myAvatar={...av,hash}}else{localStorage.removeItem(prefix+'av.me');if(typeof myAvatar!=='undefined')myAvatar=null}}
    if(typeof refreshAvatars==='function')await refreshAvatars();
   }
  },
  restoreProfile:async profile=>{
   write('nick',profile.nick);const input=document.getElementById('nick');if(input)input.value=profile.nick;if(typeof S!=='undefined')S.nick=profile.nick;if(desktop)await duo.friendsNick(profile.nick);else await alo.friendsNick({nick:profile.nick});
   const av=profile.avatar;if(desktop){const old=await duo.avatarMine(),value=old?{mime:old.mime,b64:b64(new Uint8Array(old.bytes))}:null;if(JSON.stringify(value)!==JSON.stringify(av)){if(av)await duo.avatarSetMine(unb64(av.b64),av.mime);else await duo.avatarClearMine()}if(typeof loadMyAvatar==='function')await loadMyAvatar()}
   else{if(typeof myAvatar!=='undefined'&&myAvatar?.url)URL.revokeObjectURL(myAvatar.url);if(av){const hash=(await api.hashBytes(unb64(av.b64))).slice(0,16);write('av.me',{...av,hash});if(typeof myAvatar!=='undefined')myAvatar={...av,hash}}else{localStorage.removeItem(prefix+'av.me');if(typeof myAvatar!=='undefined')myAvatar=null}}
   if(typeof refreshAvatars==='function')await refreshAvatars();
  },
  restoreData:data=>window.accountLabData.restore(data),
  receiveAsset:(id,m)=>window.accountLabData.receive(id,m),
  assetStatus:()=>window.accountLabData.status(),
  hashBytes:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join(''),
  changed:()=>window.dispatchEvent(new Event('account-lab-change'))
 };
 const engine=new AccountPrototype.Engine(api);
 const sync=new (desktop?AccountSync.Manager:AccountNativeManager)(engine,api);
 const lab=window.accountLab={engine,sync,api,platform,visible:true,
  handlesFriendCode:e=>!!engine.s&&['invite','linking','verify','exchange','choices','review','committing'].includes(engine.s.phase),
  ownDeviceIds:()=>engine.account?.devices.map(d=>d.id)||[],
  async setName(n){if(engine.s&&engine.s.phase!=='done')throw Error('Сначала завершите подключение');const apply=async()=>{write('nick',String(n||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24)||'Без имени');const inp=document.getElementById('nick');if(inp)inp.value=read('nick','');if(desktop)await duo.friendsNick(read('nick',''));else await alo.friendsNick({nick:read('nick','')})};if(engine.account)await lab.sync.mutate(apply);else await apply();},
  nick:()=>read('nick',''),deviceName:()=>read('accountLab.deviceName',desktop?'Мой ПК':'Мой телефон'),
  async copy(text){if(desktop)await duo.copy(text);else await alo.copy({text})},
  async paste(){const r=desktop?await duo.paste():await alo.paste();return typeof r==='string'?r:r.text||''},
  ready:null
 };
 const dmRouteType='account-dm-route-v1';
 const dmChecks=new Map();
 let dmSending=false,lastDmAttempt=null;
 const dmMid=/^[a-z0-9]{1,24}$/i;
 function dmLink(target){
  const account=engine.account;
  if(lab.restoring||engine.s&&engine.s.phase!=='done'||!account?.friends.some(f=>f.id===target))return null;
  const peer=account.devices.find(d=>d.kind==='desktop'&&d.id===lab.sync.peer);
  return peer&&{account:account.id,peer:peer.id};
 }
 function dmRequests(){return read('accountLab.dmRequests',[])}
 function sendDmRoute(link,fields){
  return Promise.resolve().then(()=>api.send(link.peer,{t:dmRouteType,account:link.account,...fields})).catch(()=>({ok:false}));
 }
 async function retryDmRequests(){
  if(dmSending)return;
  const pending=dmRequests().filter(r=>{
   const link=dmLink(r.target);
   return !r.status&&link?.account===r.account&&link.peer===r.peer;
  });
  if(!pending.length)return;
  const request=pending[(pending.findIndex(r=>r.message.mid===lastDmAttempt)+1)%pending.length];
  lastDmAttempt=request.message.mid;
  dmSending=true;
  try{await sendDmRoute(request,{kind:'send',target:request.target,mid:request.message.mid,message:request.message})}
  finally{dmSending=false}
 }
 async function routeDm(target,message){
  const link=dmLink(target);
  if(!link)return null;
  // The native DM API queues immediately. A harmless reliable packet determines whether to use it.
  const direct=await new Promise(resolve=>{
   const timer=setTimeout(()=>resolve(false),1800);
   Promise.resolve().then(()=>api.send(target,{t:'dm-path-check-v1'})).then(r=>resolve(r?.ok===true),()=>resolve(false)).finally(()=>clearTimeout(timer));
  });
  const directResult=direct?await api.send(target,message):null;
  if(direct&&directResult?.ok!==false)return directResult||{ok:false};
  const mid=message.mid;
  const ready=await new Promise(resolve=>{
   const timer=setTimeout(()=>{dmChecks.delete(mid);resolve(false)},2500);
   dmChecks.set(mid,{...link,target,resolve:()=>{clearTimeout(timer);dmChecks.delete(mid);resolve(true)}});
   void sendDmRoute(link,{kind:'check',target,mid});
  });
  const current=dmLink(target);
  if(!ready||current?.account!==link.account||current.peer!==link.peer)return directResult;
  const requests=dmRequests().filter(r=>r.account===link.account&&(!r.status||Date.now()-r.at<7*86400000));
  if(requests.length>=1000){
   const completed=requests.findIndex(r=>r.status);
   if(completed<0)return directResult;
   requests.splice(completed,1);
  }
  try{write('accountLab.dmRequests',[...requests,{...link,target,message,at:Date.now()}])}
  catch{return directResult}
  void retryDmRequests();
  return {ok:true,queued:true};
 }
 function receiveDmRoute(id,msg){
  if(typeof msg.mid!=='string'||!dmMid.test(msg.mid))return;
  const link=dmLink(msg.target);
  if(!link||id!==link.peer||msg.account!==link.account)return;
  if(msg.kind==='ready'){
   const check=dmChecks.get(msg.mid);
   if(check?.target===msg.target&&check.peer===id&&check.account===msg.account)check.resolve();
  }else if(msg.kind==='result'&&['sent','queued'].includes(msg.status)){
   const requests=dmRequests(),request=requests.find(r=>r.message.mid===msg.mid&&r.target===msg.target&&r.account===link.account&&r.peer===id);
   if(!request||request.status)return;
   if(msg.status==='sent')applyLinkedDmSent(msg.target,msg.mid);
   write('accountLab.dmRequests',requests.map(r=>r===request?{...r,message:{mid:msg.mid},status:msg.status,at:Date.now()}:r));
  }
 }
 if(!desktop){
  lab.routeDm=routeDm;
  lab.canRouteDm=target=>!!dmLink(target);
  lab.ownsRelayedDm=(target,mid)=>{const link=dmLink(target);return !!link&&dmRequests().some(r=>r.account===link.account&&r.peer===link.peer&&r.target===target&&r.message.mid===mid)};
  alo.on('friendMsg',({id,msg})=>{if(msg?.t===dmRouteType)void Promise.resolve(lab.ready).then(()=>receiveDmRoute(id,msg)).catch(()=>{})});
  setInterval(()=>{if(document.visibilityState==='visible')void retryDmRequests()},5000);
 }
 if(desktop){duo.onFriendMsg(e=>{if(!lab.restoring)engine.receive(e.id,e.msg)});}else{alo.on('friendMsg',e=>{if(!lab.restoring)engine.receive(e.id,e.msg)});}
 const recovery=window.accountRecovery, copyToRestore=localStorage.getItem('alloconnect.account.restore');
 lab.restoring=!!copyToRestore||recovery.unlinkPending();
 lab.ready=engine.init().then(async()=>{
  if(copyToRestore)return recovery.restore(copyToRestore);
  if(recovery.unlinkPending())await recovery.unlink();
  else await recovery.resumePhoneHistory();
  return lab.sync.init();
 }).catch(e=>engine.fail(e));
 setInterval(()=>{if(!lab.restoring)engine.tick()},3500);
 setInterval(()=>{if(desktop||document.visibilityState==='visible'){lab.sync.tick();window.accountLabData.tick()}},1500);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')lab.sync.tick()});
 let nameTimer=null;document.addEventListener('input',event=>{if(event.target.id==='nick'&&engine.account){clearTimeout(nameTimer);nameTimer=setTimeout(()=>lab.sync.tick(),400)}});
})();
