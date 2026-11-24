'use strict';
(()=>{
 const desktop=typeof window.duo?.onFriendMsg==='function',prefix=desktop?'duo.':'aloc.',kind=desktop?'desktop':'phone',copy=x=>JSON.parse(JSON.stringify(x)),stable=AccountData.stable;
 const read=(k,d)=>{const v=localStorage.getItem(prefix+k);return v===null?d:(JSON.parse(v)??d)};
 const excluded=new Set(['turnPass','turnUser','turnUrl','relayUrl','stunCustom','mic','out','cam','camera','speaker','micId','camId','speakerId']);
 let opening,hydrating,phoneHistory={},phoneSavedSnapshot={},phoneRevision=0,phoneSavedRevision=-1,writing=null,ready=false,busy=false,assetError='',waiting=null,lastRequest=0,pending=0,call=null,detaching=false;
 const mediaCache=new Map();
 function db(){return opening||=new Promise((resolve,reject)=>{const r=indexedDB.open('account-lab-assets',1);r.onupgradeneeded=()=>{r.result.createObjectStore('assets');r.result.createObjectStore('chunks')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{opening=null;reject(r.error)}})}
 async function storage(table,mode,fn){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(table,mode);let r;try{r=fn(tx.objectStore(table))}catch(e){tx.abort();reject(e);return}tx.oncomplete=()=>resolve(r?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить вложение'))})}
 const get=async hash=>{if(desktop)return storage('assets','readonly',s=>s.get(hash));const info=await alo.accountLabAssetInfo({hash});if(!info.ok)throw Error(info.error||'Не удалось прочитать вложение');if(!info.exists)return undefined;const response=await fetch('/_alo/account-assets/'+hash);if(!response.ok)throw Error('Не удалось прочитать вложение');return new Blob([await response.arrayBuffer()],{type:info.mime})};
 const put=async(hash,blob)=>{if(desktop)return storage('assets','readwrite',s=>s.put(blob,hash));for(let offset=0;offset<Math.max(blob.size,1);offset+=49152){const bytes=new Uint8Array(await blob.slice(offset,offset+49152).arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);const r=await alo.accountLabAssetWrite({hash,offset,size:blob.size,b64:btoa(text)});if(!r.ok)throw Error(r.error||'Не удалось сохранить вложение')}return true};
 const lab=()=>window.accountLab;
 const appKeys=['tray','closeToTray','minToTray','startHidden','bossKey','notify','ownNotify','saveChatFiles'];
 async function nativeSettings(){if(!desktop)return {};const app=await duo.appSettingsGet(),hotkeys=await duo.hotkeysGet(),out={};for(const k of appKeys)if(typeof app[k]==='boolean')out['app.'+k]=app[k];for(const [k,v] of Object.entries(hotkeys.keys||{}))if(typeof v==='string')out['hotkey.'+k]=v;return out}
 async function hashBlob(blob){return lab().api.hashBytes(new Uint8Array(await blob.arrayBuffer()))}
 function legacyPhoneHistory(){
  const history={};
  for(const key of Object.keys(localStorage))if(key.startsWith(prefix+'hist.'))history[key.slice((prefix+'hist.').length)]=read(key.slice(prefix.length),[]);
  return history;
 }
 async function hydrate(mergeLegacy=false){
  if(desktop)return;
  if(hydrating)return hydrating;
  hydrating=(async()=>{
   if(!ready){
    const r=await alo.accountLabHistoryRead();
    if(!r.ok)throw Error(r.error||'Не удалось прочитать историю');
    phoneHistory=r.history||{};phoneSavedSnapshot=copy(phoneHistory);
    const legacy=legacyPhoneHistory();
    phoneHistory=mergeLegacy?mergeLocalHistory({},legacy,phoneHistory):{...legacy,...phoneHistory};
    ready=true;
   }
   await flushPhone();
   for(const key of Object.keys(localStorage))if(key.startsWith(prefix+'hist.'))localStorage.removeItem(key);
  })().finally(()=>{hydrating=null});
  return hydrating;
 }

 function mergeLocalHistory(base,current,remote){const out=copy(remote);for(const id of new Set([...Object.keys(base),...Object.keys(current)])){const old=new Map((base[id]||[]).map(e=>[AccountData.key(e),e])),now=new Map((current[id]||[]).map(e=>[AccountData.key(e),e])),merged=new Map((out[id]||[]).map(e=>[AccountData.key(e),e]));for(const k of new Set([...old.keys(),...now.keys()]))if(stable(old.get(k)??null)!==stable(now.get(k)??null)){if(now.has(k))merged.set(k,now.get(k));else merged.delete(k)}out[id]=[...merged.values()]}return out}
 function flushPhone(){if(detaching)return Promise.resolve();if(writing)return writing.then(()=>phoneSavedRevision===phoneRevision?undefined:flushPhone());writing=(async()=>{while(!detaching&&phoneSavedRevision!==phoneRevision){const revision=phoneRevision,snapshot=copy(phoneHistory),json=JSON.stringify(snapshot),r=await alo.accountLabHistoryWrite({json,base:JSON.stringify(phoneSavedSnapshot)});if(!r.ok)throw Error(r.error||'Не удалось сохранить историю');const actual=r.history||snapshot;phoneHistory=revision===phoneRevision?copy(actual):mergeLocalHistory(snapshot,phoneHistory,actual);phoneSavedSnapshot=copy(actual);phoneSavedRevision=revision;}})().finally(()=>{writing=null});return writing}

 async function preservePhoneHistory(checkpoint, save, reset){
  if(!checkpoint)await hydrate();
  detaching=true;
  try{
   await writing;
   const result=await alo.accountLabHistoryRead();
   if(!result.ok)throw Error(result.error||'Не удалось прочитать историю');
   const base=phoneSavedSnapshot, current=result.history||{};
   const recovered=checkpoint?mergeLocalHistory({},current,checkpoint):current;
   const history=mergeLocalHistory(base,phoneHistory,recovered);
   await save(history);
   await reset();
   phoneHistory=mergeLocalHistory(base,phoneHistory,history);
   if(!ready)phoneHistory=mergeLocalHistory({},legacyPhoneHistory(),phoneHistory);
   phoneSavedSnapshot={};
   phoneSavedRevision=-1;
   phoneRevision++;
   ready=true;
  }finally{detaching=false}
  await flushPhone();
 }

 function setHistory(id,rows){phoneHistory[id]=rows;phoneRevision++;flushPhone().catch(e=>{assetError=e.message;lab()?.engine.fail(e)});return true}

 async function source(id,e,dry=false){if(e.type!=='file')return e;const f=e.file?{...e.file}:{name:e.name||'файл',size:0,mime:'application/octet-stream',kind:'file',p:'chat',...(e.st===1?{st:1}:{})};let saved=null,cacheKey;
  if(desktop&&f.stored){cacheKey=id+'|'+f.stored;saved=mediaCache.get(cacheKey);if(!saved){try{saved={blob:new Blob([await duo.histMediaRead(id,f.stored)],{type:f.mime})}}catch{}}}
  else if(!desktop){const raw=await historyFiles.get(id,e.mid);if(raw){saved={blob:raw.blob};Object.assign(f,raw.meta);delete f.fid}}
  if(saved?.blob&&dry){f.asset='0'.repeat(64);f.size=saved.blob.size;}else if(saved?.blob){if(!saved.hash)saved.hash=await hashBlob(saved.blob);f.asset=saved.hash;f.size=saved.blob.size;if(!await get(f.asset))await put(f.asset,saved.blob);if(cacheKey)mediaCache.set(cacheKey,saved)}
  delete f.stored;return {...e,file:f,name:undefined,st:e.st===1?undefined:e.st};
 }
 async function snapshot(dry=false){if(!dry){await hydrate();if(!desktop)await flushPhone()}const raw=desktop?await duo.accountLabHistoryRead():dry?await alo.accountLabHistoryRead():{ok:true,history:phoneHistory};if(dry&&!desktop){raw.history=copy(raw.history||{});for(const key of Object.keys(localStorage))if(key.startsWith(prefix+'hist.')){const id=key.slice((prefix+'hist.').length);if(!raw.history[id])raw.history[id]=read('hist.'+id,[])}}if(!raw.ok)throw Error(raw.error||'Не удалось прочитать историю');const history={};for(const [id,rows] of Object.entries(raw.history||{})){if(lab()?.ownDeviceIds().includes(id))continue;history[id]=[];for(const rawEntry of rows){const e=copy(rawEntry);if(!['text','file','op','status'].includes(e.type))continue;if(e.type==='status'){history[id].push({type:'status',ref:e.ref,st:e.st});continue}if(typeof e.st==='string'){history[id].push({type:'status',ref:e.mid,st:e.st});delete e.st;}const normalized=await source(id,e,dry);if((e.type==='text'||e.type==='file')&&!normalized.mid)normalized.mid='legacy-'+(await lab().api.hash(stable(normalized))).slice(0,24);history[id].push(AccountData.snapshot({history:{[id]:[normalized]}}).history[id][0])}history[id]=[...new Map(history[id].map(e=>[AccountData.key(e),e])).values()]}
  const settings=copy(lab()?.engine.account?.data?.settings||{desktop:{},phone:{}});settings[kind]={};for(const [k,v] of Object.entries(read('settings',{})))if(!excluded.has(k)&&!/(pass|token|secret|deviceId)/i.test(k)&&['string','number','boolean'].includes(typeof v))settings[kind][k]=v;
  Object.assign(settings[kind],await nativeSettings());return {history,calls:read('accountLab.calls',[]),settings};
 }
 async function refresh(ids){if(typeof convs==='undefined')return;for(const id of ids){const c=convs.get(id);if(!c)continue;if(desktop)clearConvMedia(c);else{c.box.replaceChildren();c.msgs?.clear()}c.loaded=false;await loadHistory(c);scrollEnd(c)} }
 async function apply(data,restore=false){await hydrate();const desired=AccountData.snapshot(data),before=await snapshot(),old=lab()?.engine.account?.data||{history:{}};const changed=[];
  if(!desktop){await flushPhone();const r=await alo.accountLabHistoryRead();if(!r.ok)throw Error(r.error||'Не удалось прочитать историю');const oldHistory=phoneHistory;phoneHistory=mergeLocalHistory(phoneSavedSnapshot,phoneHistory,r.history||{});phoneSavedSnapshot=copy(r.history||{});for(const id of new Set([...Object.keys(oldHistory),...Object.keys(phoneHistory)]))if(stable(oldHistory[id]||[])!==stable(phoneHistory[id]||[]))changed.push(id)}
  for(const id of (desktop?new Set([...Object.keys(desired.history),...Object.keys(old.history||{})]):[])){const rows=desired.history[id]||[],current=before.history[id]||[];if(stable(rows)===stable(current))continue;
   // Preserve records written after the manager's capture while native I/O was pending.
   const known=new Map((old.history?.[id]||[]).map(e=>[AccountData.key(e),stable(e)])),wanted=new Map(rows.map(e=>[AccountData.key(e),copy(e)]));if(!restore)for(const e of current){const k=AccountData.key(e);if(known.get(k)!==stable(e))wanted.set(k,e)}
   const native=[];for(const e of wanted.values()){const out=copy(e);if(out.type==='file'){const blob=out.file.asset?await get(out.file.asset):null;if(desktop){const existing=await duo.histLoad(id,1000000);const prior=existing.items.find(x=>x.mid===out.mid);if(prior?.file?.stored)out.file.stored=prior.file.stored;else if(blob)out.file.stored=await duo.histMediaSave(id,new Uint8Array(await blob.arrayBuffer()),out.file.name)}else{out.name=out.file.name;if(out.file.st)out.st=1;if(blob)await historyFiles.restore(id,out.mid,out.file,blob)}}native.push(out)}
   if(desktop){const r=await duo.accountLabHistoryWrite(id,native);if(!r.ok)throw Error(r.error||'Не удалось сохранить историю')}else{phoneHistory[id]=native;phoneRevision++;await flushPhone()}changed.push(id)
  }
  const currentSettings={...read('settings',{}),...await nativeSettings()},incoming=desired.settings[kind],prior=old.settings?.[kind]||{};let settingChanged=false;for(const k of new Set([...Object.keys(prior),...Object.keys(incoming)])){if(excluded.has(k)||/(pass|token|secret|deviceId)/i.test(k))continue;if(!restore&&stable(currentSettings[k]??null)!==stable(prior[k]??null))continue;if(stable(currentSettings[k]??null)===stable(incoming[k]??null))continue;if(k in incoming)currentSettings[k]=incoming[k];else delete currentSettings[k];settingChanged=true}if(settingChanged){const app={},hotkeys={};for(const [k,v] of Object.entries(currentSettings)){if(k.startsWith('app.')){if(appKeys.includes(k.slice(4)))app[k.slice(4)]=v;delete currentSettings[k]}else if(k.startsWith('hotkey.')){hotkeys[k.slice(7)]=v;delete currentSettings[k]}}if(desktop){if(Object.keys(app).length)await duo.appSettingsSet(app);for(const [k,v] of Object.entries(hotkeys)){if(prior['hotkey.'+k]===v)continue;const r=await duo.hotkeysSet(k,v);if(r?.ok===false)throw Error('Не удалось назначить горячую клавишу '+v)}}localStorage.setItem(prefix+'settings',JSON.stringify(currentSettings));if(typeof applyTheme==='function')applyTheme(currentSettings.theme||'');document.documentElement.classList.toggle('no-ui-animations',currentSettings.animations===false);if(desktop)await duo.uiScale(currentSettings.uiScale||1);if(typeof fillSettings==='function')fillSettings()}
  const calls=new Map(desired.calls.map(c=>[c.mid,c])),oldCalls=new Map((old.calls||[]).map(c=>[c.mid,stable(c)]));if(!restore)for(const c of read('accountLab.calls',[]))if(oldCalls.get(c.mid)!==stable(c))calls.set(c.mid,c);localStorage.setItem(prefix+'accountLab.calls',JSON.stringify([...calls.values()]));await refresh(changed);
 }
 function files(){const data=lab()?.engine.account?.data;const map=new Map();for(const [id,rows] of Object.entries(data?.history||{})){const dead=new Set(rows.filter(e=>e.type==='op'&&e.op==='del').map(e=>e.who+':'+e.ref));for(const e of rows)if(e.type==='file'&&e.file?.asset&&!e.deleted&&!dead.has(e.who+':'+e.mid))map.set(e.file.asset,{id,mid:e.mid,...e.file})}return map}
 async function send(msg){return lab().api.send(lab().sync.peer,{t:'account-asset-v1',account:lab().engine.account.id,...msg})}
 async function receive(id,m){if(!lab()?.sync.peer||id!==lab().sync.peer||m.account!==lab().engine.account.id||!(/^[a-f0-9]{64}$/).test(m.hash))return;try{
  const f=files().get(m.hash);if(!f)return;
  if(m.kind==='get'){if(!Number.isInteger(m.offset)||m.offset<0||m.offset%49152||m.offset>=f.size)return;const blob=await get(m.hash);if(!blob)return;const bytes=new Uint8Array(await blob.slice(m.offset,m.offset+49152).arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);await send({kind:'part',hash:m.hash,offset:m.offset,size:blob.size,b64:btoa(text)});return}
  if(m.kind!=='part'||!waiting||waiting.hash!==m.hash||waiting.offset!==m.offset||m.size!==f.size||typeof m.b64!=='string'||m.b64.length>65536||!/^[A-Za-z0-9+/]*={0,2}$/.test(m.b64))return;
  const bytes=Uint8Array.from(atob(m.b64),c=>c.charCodeAt(0));if(bytes.length!==Math.min(49152,f.size-m.offset))return;await storage('chunks','readwrite',s=>s.put(new Blob([bytes]),m.hash+':'+m.offset));waiting=null;lastRequest=0;await tick();
 }catch(e){assetError=e.message;lab().sync.updateStatus()}}
 async function tick(){if(!desktop)return;if(lab()?.restoring||busy||!lab()?.engine.account||!lab()?.sync.peer)return;busy=true;try{pending=0;for(const [hash,f] of files()){const present=await get(hash);if(present){await installFile(hash,present);continue}pending++;let missing=-1;const chunks=[];for(let offset=0;offset<f.size;offset+=49152){const part=await storage('chunks','readonly',s=>s.get(hash+':'+offset));if(!part){missing=offset;break}chunks.push(part)}if(missing<0){const blob=new Blob(chunks,{type:f.mime});if(await hashBlob(blob)!==hash){for(let o=0;o<f.size;o+=49152)await storage('chunks','readwrite',s=>s.delete(hash+':'+o));throw Error('Контрольная сумма вложения не совпала')}await put(hash,blob);for(let o=0;o<f.size;o+=49152)await storage('chunks','readwrite',s=>s.delete(hash+':'+o));await installFile(hash,blob);pending--;continue}if(Date.now()-lastRequest>=3000||!waiting){waiting={hash,offset:missing};lastRequest=Date.now();await send({kind:'get',hash,offset:missing})}break}assetError='';lab().sync.updateStatus()}catch(e){assetError=e.message;lab().sync.updateStatus()}finally{busy=false}}
 async function installFile(hash,blob){const data=lab().engine.account.data;for(const [id,rows] of Object.entries(data.history||{}))for(const e of rows)if(e.type==='file'&&e.file?.asset===hash){if(desktop){const raw=await duo.accountLabHistoryRead(),list=raw.history[id]||[],native=list.find(x=>x.mid===e.mid);if(!native||native.file?.stored)continue;if(native&&!native.file?.stored){native.file={...e.file,stored:await duo.histMediaSave(id,new Uint8Array(await blob.arrayBuffer()),e.file.name)};const r=await duo.accountLabHistoryWrite(id,list);if(!r.ok)throw Error('Не удалось сохранить файл')}}else{const native=await historyFiles.get(id,e.mid);if(native?.meta?.asset===hash&&native.blob?.size===blob.size)continue;await historyFiles.restore(id,e.mid,e.file,blob)}await refresh([id])}}
 function observeCall(){if(typeof S==='undefined'||!lab()?.engine.account)return;const attempt=S.friendCall,active=!!S.connected;
  if((attempt||active)&&!call){call={type:'call',mid:attempt?.cid||lab().api.random(),ts:Date.now(),peer:attempt?.id||S.callConv?.id||null,nick:attempt?.nick||S.friendNick||'Звонок',direction:attempt?.dir||'manual',device:lab().platform,outcome:active?'connected':'pending'};saveCall(call)}
  if(call&&active&&call.outcome!=='connected'){call.outcome='connected';call.connectedAt=Date.now();saveCall(call)}
  if(call&&!active&&!attempt&&!S.inCall&&!S.pc){call.ended=Date.now();call.duration=call.outcome==='connected'?Math.max(0,Math.round((call.ended-(call.connectedAt||call.ts))/1000)):0;if(call.outcome==='pending')call.outcome=call.direction==='in'?'missed':'unanswered';saveCall(call);call=null;lab().sync.tick()}
 }
 function saveCall(value){const rows=read('accountLab.calls',[]),at=rows.findIndex(e=>e.mid===value.mid);if(at<0)rows.push(copy(value));else rows[at]=copy(value);localStorage.setItem(prefix+'accountLab.calls',JSON.stringify(rows))}

 setInterval(observeCall,500);
 window.accountLabData={summary:async()=>{const data=await snapshot(true),self=(await lab().api.info()).id,rows=AccountData.capture([],{},data,self,()=>[1,self]);return {messages:Object.values(data.history).flat().filter(e=>['text','file'].includes(e.type)).length,rows:rows.length,bytes:new TextEncoder().encode(stable(rows)).length*2}},nativeFile:async(id,mid)=>{const e=lab()?.engine.account?.data?.history?.[id]?.find(e=>e.type==='file'&&e.mid===mid);if(!e?.file?.asset)return null;const blob=await get(e.file.asset);return blob?{meta:e.file,blob}:null},snapshot,apply,restore:data=>apply(data,true),receive,tick,status:()=>assetError?'Вложения: '+assetError:pending?'Передаём вложения; история сохранена':'',get ready(){return ready},getHistory:id=>phoneHistory[id]||[],setHistory,clearHistory:id=>{if(id)delete phoneHistory[id];else phoneHistory={};phoneRevision++;return flushPhone()},hydrate,preservePhoneHistory,assets:{get,put,storage},calls:()=>read('accountLab.calls',[])};
})();
