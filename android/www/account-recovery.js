'use strict';
(()=>{
 const desktop=typeof window.duo?.onFriendMsg==='function',prefix=desktop?'duo.':'aloc.';
 let opening, unlinking;
 const phoneHistoryMode='alloconnect.account.phoneHistory';
 const db=()=>opening||=new Promise((resolve,reject)=>{const r=indexedDB.open('alloconnect-account-recovery',2);r.onupgradeneeded=event=>{if(event.oldVersion<1){r.result.createObjectStore('copies');r.result.createObjectStore('files')}r.result.createObjectStore('unlink')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{opening=null;reject(r.error)}});
 async function run(table,mode,fn){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(table,mode);let req;try{req=fn(tx.objectStore(table))}catch(e){tx.abort();reject(e);return}tx.oncomplete=()=>resolve(req?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить копию'))})}
 const check=r=>{if(!r?.ok)throw Error(r?.error||'Не удалось восстановить данные');return r};

 const unlinkPending=()=>!desktop&&localStorage.getItem(phoneHistoryMode)==='pending';
 async function resumePhoneHistory(){
  if(!desktop&&localStorage.getItem(phoneHistoryMode)==='ready')await window.accountLabData.hydrate(true);
 }

 function unlink(){
  if(!unlinking)unlinking=detachPhone().finally(()=>{unlinking=null});
  return unlinking;
 }

 async function detachPhone(){
  const lab=window.accountLab,{engine,sync}=lab;
  const pending=unlinkPending();
  if(desktop||(!pending&&(!engine.account||engine.s)))throw Error('Нет устройства для отвязки');
  lab.restoring=true;
  try{
   await engine.serial;
   await sync.queue;
   const checkpoint=pending?await run('unlink','readonly',s=>s.get('history')):undefined;
   if(checkpoint||!pending){
    await window.accountLabData.preservePhoneHistory(checkpoint,async history=>{
     await run('unlink','readwrite',s=>s.put(history,'history'));
     localStorage.setItem(phoneHistoryMode,'pending');
    },async()=>check(await alo.accountRecoveryReset()));
    await run('unlink','readwrite',s=>s.delete('history'));
    engine.account=engine.receipt=engine.syncState=engine.syncRecovery=null;
    lab.sync=new AccountNativeManager(engine,lab.api);
   }
   localStorage.setItem(phoneHistoryMode,'ready');
   await resumePhoneHistory();
  }finally{
   lab.restoring=unlinkPending();
   engine.emit();
  }
 }
 async function backup(sid){
  if(!/^[a-f0-9]{32}$/.test(sid))throw Error('Неверная операция');
  if(await run('copies','readonly',s=>s.get(sid)))return;
  await navigator.storage?.persist?.();
  const lab=window.accountLab,info=await lab.api.info(),raw=check(desktop?await duo.accountLabHistoryRead():await alo.accountLabHistoryRead());
  const history=JSON.parse(JSON.stringify(raw.history||{}));
  if(!desktop)for(const key of Object.keys(localStorage))if(key.startsWith(prefix+'hist.')){const id=key.slice((prefix+'hist.').length);if(!history[id])history[id]=JSON.parse(localStorage.getItem(key))}
  const storage=Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith(prefix)).map(k=>[k,localStorage.getItem(k)]));
  const profile=await lab.api.snapshot(info),files=[];
  for(const [id,rows]of Object.entries(history))for(const e of rows){if(e.type!=='file')continue;let saved;
   if(desktop&&e.file?.stored){try{saved={blob:new Blob([await duo.histMediaRead(id,e.file.stored)],{type:e.file.mime}),meta:e.file}}catch(error){if(!/\bENOENT\b/.test(String(error?.message||error)))throw error}}
   else if(!desktop)saved=await historyFiles.get(id,e.mid);
   if(saved?.blob){const key=sid+'|'+id+'|'+e.mid;await run('files','readwrite',s=>s.put(saved,key));files.push({key,id,mid:e.mid})}
  }
  const peer=lab.engine.s?.peer;
  // The pairing transport contact did not belong to the original user profile.
  if(!lab.engine.s?.wasFriend)profile.friends=profile.friends.filter(f=>f.id!==peer);
  const native=desktop?{app:await duo.appSettingsGet(),hotkeys:await duo.hotkeysGet()}:{status:await alo.status()};
  // This single committed marker makes an interrupted/incomplete copy unusable.
  await run('copies','readwrite',s=>s.put({v:1,sid,at:Date.now(),self:info.id,storage,profile,history,files,native},sid));
 }
 async function restore(sid){
  const c=await run('copies','readonly',s=>s.get(sid));if(!c||c.self!==(await accountLab.api.info()).id)throw Error('Копия не найдена или относится к другому устройству');
  const lab=window.accountLab;lab.restoring=true;
  // Finish queued frontend writes before resetting the native owner.
  await lab.engine.serial;await lab.sync.queue;
  localStorage.setItem('alloconnect.account.restore',sid);
  check(desktop?await duo.accountRecoveryReset():await alo.accountRecoveryReset());
  lab.engine.account=null;lab.engine.s=null;lab.sync.state=null;
  const current=desktop?await duo.accountLabInfo():await alo.accountLabInfo(),wanted=new Set(c.profile.friends.map(f=>f.id));
  for(const f of current.list||[])if(!wanted.has(f.id))await lab.api.remove(f.id);
  for(const f of c.profile.friends){const r=desktop?await duo.accountLabUpsert(f):await alo.accountLabUpsert(f);if(r===false||r?.ok===false)throw Error('Не удалось восстановить контакт')}
  for(const ref of c.files){const f=await run('files','readonly',s=>s.get(ref.key));if(!f?.blob)throw Error('Копия вложения недоступна');
   if(desktop){const stored=await duo.histMediaSave(ref.id,new Uint8Array(await f.blob.arrayBuffer()),f.meta.name);const e=c.history[ref.id].find(e=>e.mid===ref.mid);e.file={...f.meta,stored};}
   else await historyFiles.restore(ref.id,ref.mid,f.meta,f.blob);
  }
  if(desktop){const current=check(await duo.accountLabHistoryRead());for(const id of new Set([...Object.keys(current.history),...Object.keys(c.history)]))check(await duo.accountLabHistoryWrite(id,c.history[id]||[]));}
  // An unlinked app writes its legacy history to localStorage. Do not leave a stale
  // native cache that could override those new messages on the next connection.
  else check(await alo.accountLabHistoryWrite({json:'{}',base:'{}'}));
  for(const key of Object.keys(localStorage))if(key.startsWith(prefix))localStorage.removeItem(key);
  for(const [k,v]of Object.entries(c.storage))localStorage.setItem(k,v);
  if(desktop){await duo.appSettingsSet(c.native.app);const current=(await duo.hotkeysGet()).keys||{};for(const [k,v]of Object.entries(c.native.hotkeys.keys||{})){if(current[k]===v)continue;await duo.hotkeysSet(k,v);if((await duo.hotkeysGet()).keys[k]!==v)throw Error('Не удалось сохранить горячие клавиши')}}
  else if(c.native.status)await alo.setOnlineBg({on:!!c.native.status.onlineBg});
  await lab.api.restoreProfile(c.profile.profile);
  localStorage.removeItem('alloconnect.account.restore');if(desktop)await duo.accountRecoveryReload();else location.reload();
 }
 async function choose(container){const copies=await run('copies','readonly',s=>s.getAll());container.replaceChildren();for(const c of copies.sort((a,b)=>b.at-a.at)){const b=document.createElement('button');b.textContent='Восстановить: '+new Date(c.at).toLocaleString('ru-RU');b.onclick=async()=>{if(!confirm('Вернуть данные этого устройства к состоянию до объединения? Изменения после этой копии будут заменены.'))return;b.disabled=true;try{await restore(c.sid)}catch(e){accountLab.engine.fail(e);b.disabled=false}};container.append(b)}if(!copies.length)container.textContent='Сохранённых копий пока нет. Копия создаётся перед объединением.'}
 window.accountRecovery={backup,restore,choose,unlink,unlinkPending,resumePhoneHistory,list:()=>run('copies','readonly',s=>s.getAll())};
})();
