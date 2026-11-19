(function(scope){
'use strict';
const ID=/^[A-Za-z0-9_-]{43}$/,SID=/^[a-f0-9]{32}$/,MAX=100;
const clean=s=>String(s||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24);
const clone=x=>JSON.parse(JSON.stringify(x));
const stable=x=>JSON.stringify(x===undefined?null:x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const compareId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
function check(v,message){if(!v)throw Error(message)}
function avatar(a){if(a==null)return null;check(/^image\/(png|jpeg|webp|gif)$/.test(a.mime)&&typeof a.b64==='string'&&a.b64.length>0&&a.b64.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(a.b64)&&a.b64.length/4*3-(a.b64.endsWith('==')?2:a.b64.endsWith('=')?1:0)<=1048576,'Аватар должен быть PNG/JPEG/WebP/GIF до 1 МБ');return {mime:a.mime,b64:a.b64}}

function addresses(xs){return (Array.isArray(xs)?xs:[]).filter(a=>a&&['lan','tailscale','stun','upnp','public'].includes(a.kind)&&/^\d+\.\d+\.\d+\.\d+$/.test(a.ip)&&a.ip.split('.').every(n=>+n<=255)&&Number.isInteger(a.port)&&a.port>0&&a.port<=65535).slice(0,8).map(a=>({kind:a.kind,ip:a.ip,port:a.port}))}
function snapshot(s){check(s&&ID.test(s.device?.id),'Не получен идентификатор устройства');check(Array.isArray(s.friends)&&s.friends.length<=MAX,'В прототипе поддерживается до 100 друзей');
 const summary=s.dataSummary||{messages:0,rows:0,bytes:0};for(const k of ['messages','rows','bytes'])check(Number.isSafeInteger(summary[k])&&summary[k]>=0&&summary[k]<=128*1024*1024,'Некорректный объём данных');check(!s.device.kind||['desktop','phone'].includes(s.device.kind),'Неизвестный тип устройства');const seen=new Set();const friends=s.friends.map(f=>{check(f&&ID.test(f.id)&&!seen.has(f.id),'Некорректный или повторный контакт');seen.add(f.id);return {id:f.id,nick:clean(f.nick)||'Друг',addrs:addresses(f.addrs),renamed:!!f.renamed}}).sort(compareId);
 return {dataSummary:summary,device:{id:s.device.id,...(s.device.kind?{kind:s.device.kind}:{}),name:clean(s.device.name)||'Устройство'},profile:{nick:clean(s.profile?.nick)||'Без имени',avatar:avatar(s.profile?.avatar)},friends,accountId:s.accountId||null};
}
function conflicts(a,b){const peer=new Map(b.friends.map(f=>[f.id,f]));return {profile:JSON.stringify(a.profile)!==JSON.stringify(b.profile),contacts:a.friends.filter(f=>peer.has(f.id)&&peer.get(f.id).nick!==f.nick).map(f=>({id:f.id,host:f.nick,peer:peer.get(f.id).nick}))}}
function proposal(a,b,choices,id,sid){
 a=snapshot(a);b=snapshot(b);check(SID.test(id)&&SID.test(sid),'Некорректная операция');check(!a.accountId||a.accountId===id,'Нельзя заменить существующий аккаунт ПК');check(!b.accountId||b.accountId===id,'Объединение двух уже связанных аккаунтов пока не поддерживается');
 const c=conflicts(a,b);check(!c.profile||['host','peer'].includes(choices.profile),'Выберите данные профиля');
 const selfIds=new Set([a.device.id,b.device.id]);const map=new Map(a.friends.filter(f=>!selfIds.has(f.id)).map(f=>[f.id,clone(f)]));
 for(const f of b.friends){if(selfIds.has(f.id))continue;const old=map.get(f.id);if(!old){map.set(f.id,clone(f));continue}if(old.nick!==f.nick){check(['host','peer'].includes(choices.contacts?.[f.id]),'Выберите подпись контакта');old.renamed=true;if(choices.contacts[f.id]==='peer')old.nick=f.nick}else old.renamed=old.renamed||f.renamed;old.addrs=addresses([...old.addrs,...f.addrs].filter((v,i,all)=>all.findIndex(x=>x.ip===v.ip&&x.port===v.port)===i))}
 const account={v:1,id,operation:sid,profile:clone(choices.profile==='peer'?b.profile:a.profile),friends:[...map.values()].sort(compareId),devices:[a.device,b.device]};
 check(map.size<=MAX,'В общем списке может быть до 100 друзей');check((a.dataSummary.rows+b.dataSummary.rows)<=65536,'Слишком много записей истории для объединения');check(a.dataSummary.bytes+b.dataSummary.bytes+new TextEncoder().encode(JSON.stringify(account)).length<16*1024*1024,'Слишком большой объём истории для объединения; исходные данные не изменены');check(new TextEncoder().encode(JSON.stringify(account)).length<3*1024*1024,'Слишком большой профиль');return account;
}
class Engine{
 constructor(adapter){this.a=adapter;this.s=null;this.account=null;this.error='';this.busy=false;this.serial=Promise.resolve();this.receipt=null;this.ticking=false;this.initialized=false;this.chunkBuffers=new Map()}
 emit(){this.a.changed?.(this)}
 async init(){const saved=await this.a.read();this.account=saved.account||null;this.receipt=saved.receipt||null;this.syncState=saved.sync||null;this.syncRecovery=saved.syncRecovery||null;this.initialized=true;
  if(saved.recovery){this.s={...saved.recovery,prepared:true,localVerified:true,remoteVerified:true,localApproved:true,remoteApproved:true};await this.apply();}this.emit();return this}
 async save(recovery=null){await this.a.write({v:1,account:this.account,recovery,receipt:this.receipt,sync:this.syncState||null,syncRecovery:this.syncRecovery||null})}
 fail(e){this.error=e?.message||String(e);this.emit()}
 async run(fn){try{this.error='';return await fn()}catch(e){this.fail(e);throw e}}
 async create(){return this.run(async()=>{check(this.initialized,'Данные ещё не загружены или повреждены');check(!this.s,'Сначала завершите текущую привязку');const info=await this.a.info();check(ID.test(info.id),'Канал друзей ещё запускается');check(!this.account||this.account.devices.length===1,'Можно связать два устройства');const originalFriends=(await this.a.snapshot(info)).friends.map(f=>f.id);const inv=await this.a.invite();check(inv?.code?.startsWith('ALOF.'),'Не удалось создать приглашение');
  this.s={role:'host',originalFriends,sid:this.a.random(),exp:this.a.now()+300000,phase:'invite',peer:null,invitation:inv.code,localVerified:false,remoteVerified:false};this.s.code='ALOP1.'+this.a.encode({v:2,feature:'alloconnect-account-1',sid:this.s.sid,exp:this.s.exp,code:inv.code});this.emit();return this.s.code})}
 async join(code){return this.run(async()=>{check(this.initialized,'Данные ещё не загружены или повреждены');check(!this.s,'Сначала завершите текущую привязку');const raw=String(code||'').replace(/\s/g,'');check(raw.startsWith('ALOP1.')&&raw.length<3000,'Неверный код подключения');const c=this.a.decode(raw.slice(6));check(c.v===2&&c.feature==='alloconnect-account-1','Обновите оба приложения до версии с общим аккаунтом и создайте новый код');check(SID.test(c.sid)&&c.exp>this.a.now()&&c.exp<=this.a.now()+310000&&typeof c.code==='string','Код истёк или повреждён');const parsed=await this.a.parse(c.code);check(parsed.ok&&!parsed.own&&ID.test(parsed.id),'Неверное устройство');check(!this.account,'Это устройство уже связано с аккаунтом');
  this.s={role:'peer',sid:c.sid,exp:c.exp,phase:'linking',peer:parsed.id,nonce:this.a.random(),localVerified:false,remoteVerified:false,wasFriend:!!parsed.already};const r=await this.a.use(c.code);check(r.ok,'Не удалось использовать код');this.emit()})}
 async acceptDevice(id){return this.run(async()=>{check(this.s?.role==='host'&&this.s.phase==='invite'&&ID.test(id),'Нет ожидаемой привязки');this.s.wasFriend=!!this.s.originalFriends?.includes(id);const ok=await this.a.accept(id);check(ok,'Запрос уже недоступен');this.s.peer=id;this.s.phase='linking';this.emit()})}
 async send(kind,data={}){const s=this.s;if(!s?.peer)return;const message={t:'account-prototype-v1',sid:s.sid,kind,...data},encoded=this.a.encode(message);const send=async msg=>{const r=await this.a.send(s.peer,msg);check(r!==false&&r?.ok!==false,'Устройство недоступно. Повторим после восстановления связи')};if(encoded.length<=24000){await send(message);return}check(['snapshot','proposal'].includes(kind)&&encoded.length<=4*1024*1024,'Слишком большой объём данных привязки');const batch=this.a.random(),hash=await this.a.hash(stable(message)),n=Math.ceil(encoded.length/24000);for(let i=0;i<n;i++)await send({t:'account-prototype-v1',sid:s.sid,kind:'chunk',batch,hash,n,i,data:encoded.slice(i*24000,(i+1)*24000)})}

 async startVerification(nonce){const info=await this.a.info();const s=this.s;s.nonce=nonce;const host=s.role==='host'?info.id:s.peer,peer=s.role==='peer'?info.id:s.peer;s.phrase=(await this.a.hash(s.sid+'|'+host+'|'+peer+'|'+nonce)).slice(0,16).match(/.{4}/g).join(' · ');s.phase='verify';this.emit()}
 async verify(){return this.run(async()=>{check(this.s?.phase==='verify','Сначала сравните проверочные коды');this.s.localVerified=true;await this.send('verified',{nonce:this.s.nonce});await this.exchange();this.emit()})}
 async exchange(){const s=this.s;if(!s?.localVerified||!s.remoteVerified)return;if(!s.local){const info=await this.a.info();s.local=snapshot(await this.a.snapshot(info));s.local.friends=s.local.friends.filter(f=>![info.id,s.peer].includes(f.id));}
  if(s.phase==='verify')s.phase='exchange';await this.send('snapshot',{snapshot:s.local});this.emit()}
 getConflicts(){const s=this.s;return s?.local&&s.remote?conflicts(s.role==='host'?s.local:s.remote,s.role==='host'?s.remote:s.local):null}
 async propose(choices){return this.run(async()=>{const s=this.s;check(s?.role==='host'&&s.local&&s.remote,'Ждём данные второго устройства');check(!s.localApproved&&!s.remoteApproved,'Подтверждённое предложение менять нельзя');s.choices=clone(choices);s.proposal=proposal(s.local,s.remote,choices,this.account?.id||this.a.random(),s.sid);s.digest=await this.a.hash(stable(s.proposal));s.phase='review';await this.send('proposal',{choices:s.choices,account:s.proposal,digest:s.digest});this.emit()})}
 async approve(){return this.run(async()=>{const s=this.s;check(s?.phase==='review'&&s.proposal,'Сначала проверьте результат');s.localApproved=true;await this.send('approved',{digest:s.digest});await this.commitIfReady();this.emit()})}
 recovery(){const s=this.s;return {role:s.role,sid:s.sid,peer:s.peer,proposal:s.proposal,digest:s.digest,phase:s.phase}}
 async commitIfReady(){const s=this.s;if(s?.role!=='host'||!s.localApproved||!s.remoteApproved)return;s.phase='committing';await this.a.backup?.(s.sid);await this.save(this.recovery());s.prepared=true;await this.apply();await this.send('commit',{digest:s.digest});this.emit()}
 async apply(){const s=this.s;check(s?.proposal&&s.prepared,'Нет сохранённых данных операции');await this.a.apply(clone(s.proposal));let account=clone(s.proposal);const receipt={sid:s.sid,peer:s.peer,digest:s.digest};let initial=this.syncState;if(!this.account&&this.a.initialSync){const seeded=await this.a.initialSync(account);account=seeded.account;initial=seeded.sync}else if(this.account?.data)account.data=clone(this.account.data);await this.a.write({v:1,account,receipt,sync:initial||null,recovery:s.role==='host'?this.recovery():null});this.account=account;this.receipt=receipt;this.syncState=initial||null;this.syncRecovery=null;s.applied=true;s.phase=s.role==='host'?'committing':'done';this.emit()}
 async cancel(){return this.run(async()=>{const s=this.s;if(!s)return;check(!s.localApproved&&!['committing','done'].includes(s.phase),'Операция подтверждена. Дождитесь завершения');if(s.peer)this.send('cancel').catch(()=>{});if(s.peer){await this.a.cancelLink?.(s.peer);if(!s.wasFriend)await this.a.remove(s.peer)}this.s=null;this.emit()})}
 closeDone(){check(this.s?.phase==='done','Сначала завершите операцию');this.s=null;this.emit()}
 receive(id,msg){this.serial=this.serial.then(()=>this.handle(id,msg)).catch(e=>this.fail(e));return this.serial}
 async handle(id,m){
  if(m?.t==='account-asset-v1'){this.a.receiveAsset?.(id,m);return}
  if(m?.t==='account-sync-v1'){this.syncController?.receive(id,m);return}
  if(m?.t!=='account-prototype-v1'||!SID.test(m.sid))return;
  if(m.kind==='commit'&&this.receipt?.sid===m.sid&&this.receipt.peer===id&&this.receipt.digest===m.digest){await this.a.send(id,{t:'account-prototype-v1',sid:m.sid,kind:'committed',digest:m.digest});return}
  const s=this.s;if(!s||m.sid!==s.sid)return;
  // Existing friends do not generate another native friend request. The fresh
  // invitation session and known sender bind this transport; mutual verification
  // still gates all profile exchange and both approvals gate the merge.
  if(id!==s.peer){if(s.role!=='host'||s.phase!=='invite'||s.peer||!ID.test(id)||!s.originalFriends?.includes(id)||m.kind!=='hello'||!SID.test(m.nonce)||s.exp<this.a.now())return;s.peer=id;s.wasFriend=true;s.phase='linking';}
  if(s.exp&&s.exp<this.a.now()&&!s.localApproved&&!['committing','done'].includes(s.phase)){s.phase='expired';this.emit();return}
  if(m.kind==='chunk'){if(!s.localVerified||!s.remoteVerified)return;check(SID.test(m.batch)&&/^[a-f0-9]{64}$/.test(m.hash)&&Number.isInteger(m.n)&&m.n>0&&m.n<=175&&Number.isInteger(m.i)&&m.i>=0&&m.i<m.n&&typeof m.data==='string'&&m.data.length<=24000&&/^[A-Za-z0-9_-]+$/.test(m.data),'Некорректная часть данных привязки');for(const [key,b] of this.chunkBuffers)if(this.a.now()-b.at>60000)this.chunkBuffers.delete(key);let b=this.chunkBuffers.get(m.batch);if(!b){if(this.chunkBuffers.size>=2)this.chunkBuffers.delete(this.chunkBuffers.keys().next().value);b={hash:m.hash,n:m.n,at:this.a.now(),parts:new Map()};this.chunkBuffers.set(m.batch,b)}check(b.hash===m.hash&&b.n===m.n&&(!b.parts.has(m.i)||b.parts.get(m.i)===m.data),'Несогласованные части привязки');b.parts.set(m.i,m.data);if(b.parts.size!==b.n)return;this.chunkBuffers.delete(m.batch);const encoded=Array.from({length:b.n},(_,i)=>b.parts.get(i)).join('');check(encoded.length<=4*1024*1024,'Слишком большой объём данных');const inner=this.a.decode(encoded);check(inner.t===m.t&&inner.sid===m.sid&&['snapshot','proposal'].includes(inner.kind)&&await this.a.hash(stable(inner))===b.hash,'Неверная контрольная сумма данных привязки');await this.handle(id,inner);return}
  if(m.kind==='cancel'){if(s.localApproved||s.phase==='committing'||s.phase==='done')return;if(!s.wasFriend)await this.a.remove(id);this.s=null;this.error='Второе устройство отменило подключение';this.emit();return}
  if(m.kind==='hello'&&s.role==='host'&&SID.test(m.nonce)&&['linking','verify'].includes(s.phase)){if(s.nonce&&s.nonce!==m.nonce)return;await this.startVerification(m.nonce);await this.send('hello-ok',{nonce:s.nonce});return}
  if(m.kind==='hello-ok'&&s.role==='peer'&&m.nonce===s.nonce&&s.phase==='linking'){await this.startVerification(m.nonce);return}
  if(m.kind==='verified'&&s.phrase&&m.nonce===s.nonce){s.remoteVerified=true;if(s.localVerified&&['verify','exchange'].includes(s.phase))await this.exchange();this.emit();return}
  if(!s.localVerified||!s.remoteVerified)return;
  if(m.kind==='snapshot'&&['verify','exchange','choices'].includes(s.phase)){const data=snapshot(m.snapshot);check(data.device.id===id,'Подмена устройства');if(s.remote)check(stable(s.remote)===stable(data),'Данные изменились во время привязки');s.remote=data;if(!s.local)await this.exchange();s.phase='choices';this.emit();return}
  if(m.kind==='proposal'&&s.role==='peer'&&['choices','review'].includes(s.phase)&&s.local&&s.remote){if(s.localApproved&&m.digest===s.digest)return;check(!s.localApproved,'Предложение уже подтверждено');const expected=proposal(s.remote,s.local,m.choices,m.account?.id,s.sid);check(stable(expected)===stable(m.account),'Предложение не совпадает с данными устройств');check(await this.a.hash(stable(expected))===m.digest,'Неверная контрольная сумма');s.proposal=expected;s.choices=m.choices;s.digest=m.digest;s.phase='review';this.emit();return}
  if(m.kind==='approved'&&s.proposal&&s.digest===m.digest&&s.phase==='review'){s.remoteApproved=true;await this.commitIfReady();this.emit();return}
  if(m.kind==='commit'&&s.role==='peer'&&s.localApproved&&s.digest===m.digest&&s.proposal&&['review','committing'].includes(s.phase)){s.phase='committing';await this.a.backup?.(s.sid);await this.save(this.recovery());s.prepared=true;await this.apply();await this.send('committed',{digest:s.digest});return}
  if(m.kind==='committed'&&s.role==='host'&&s.phase==='committing'&&s.applied&&m.digest===s.digest){await this.save();s.phase='done';this.emit()}
 }
 async tick(){if(this.ticking)return;this.ticking=true;try{const s=this.s;if(!s)return;if(s.exp<this.a.now()&&!s.localApproved&&!['committing','done','expired'].includes(s.phase)){s.phase='expired';this.emit();return}
  if(s.role==='peer'&&s.phase==='linking')await this.send('hello',{nonce:s.nonce});
  if(s.phase==='verify'&&s.localVerified)await this.send('verified',{nonce:s.nonce});
  if(s.phase==='exchange')await this.exchange();
  if(s.phase==='choices'&&s.local)await this.send('snapshot',{snapshot:s.local});
  if(s.phase==='review'){if(s.role==='host'&&!s.remoteApproved)await this.send('proposal',{choices:s.choices,account:s.proposal,digest:s.digest});if(s.localApproved)await this.send('approved',{digest:s.digest})}
  if(s.phase==='committing'){if(!s.prepared){await this.a.backup?.(s.sid);await this.save(this.recovery());s.prepared=true}if(!s.applied)await this.apply();await this.send(s.role==='host'?'commit':'committed',{digest:s.digest})}
 }catch(e){this.fail(e)}finally{this.ticking=false}}
}
const api={Engine,snapshot,conflicts,proposal};if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.AccountPrototype=api;
})(globalThis);
