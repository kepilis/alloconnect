'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/download/';
const KEY_FINGERPRINT = 'ac0cbbe6848d6a873464af4e57cf65933b5a7581';
const CHECK_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 90 * 1000;
const MAX_EXE = 64 * 1024 * 1024;
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const SHA = /^[a-f0-9]{64}$/;
const inflight = new Map();
function check(ok, code) { if (!ok) { const e = Error(code); e.code = code; throw e; } }
function compareVersion(a, b) { const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const n=(x[i]||0)-(y[i]||0);if(n)return Math.sign(n)}return 0; }
function record(v) { return v && VERSION.test(v.version) && SHA.test(v.sha256) && Number.isSafeInteger(v.size) && v.size>0 && v.size<=MAX_EXE ? {version:v.version,sha256:v.sha256,size:v.size} : null; }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function checkPe(bytes) {
 check(bytes.length>=128 && bytes[0]===0x4d && bytes[1]===0x5a,'not-windows-executable');
 const off=bytes.readUInt32LE(0x3c);
 check(off>=64 && off+26<=bytes.length && off<=1024*1024 && bytes.readUInt32LE(off)===0x4550 && bytes.readUInt16LE(off+4)===0x8664 && bytes.readUInt16LE(off+24)===0x20b,'not-windows-x64-executable');
}
function probeVersion(file) { return new Promise((resolve,reject)=>execFile(file,['--ignore-config','--version'],{windowsHide:true,timeout:10000,maxBuffer:4096,encoding:'utf8'},(err,out)=>{if(err)return reject(err);const v=out.trim();try{check(VERSION.test(v),'invalid-executable-version');resolve(v)}catch(e){reject(e)}})); }
let trustedKey;
async function verifyChecksumSignature(sums, sig, armoredKey) {
 const pgp = require('./vendor/openpgp/openpgp.min.cjs');
 let key;
 if (armoredKey) key=await pgp.readKey({armoredKey});
 else { trustedKey ||= pgp.readKey({armoredKey:fs.readFileSync(path.join(__dirname,'yt-dlp-public.asc'),'utf8')});key=await trustedKey;check(key.getFingerprint()===KEY_FINGERPRINT,'untrusted-signing-key'); }
 const signature = sig.toString('utf8').startsWith('-----BEGIN PGP SIGNATURE-----') ? await pgp.readSignature({armoredSignature:sig.toString('utf8')}) : await pgp.readSignature({binarySignature:new Uint8Array(sig)});
 const result=await pgp.verify({message:await pgp.createMessage({binary:new Uint8Array(sums)}),signature,verificationKeys:key});
 let valid=false;for(const s of result.signatures){try{await s.verified;valid=true}catch{}}
 check(valid,'bad-checksum-signature');
 const matches=[...sums.toString('utf8').matchAll(/^([a-fA-F0-9]{64})[ \t]+\*?yt-dlp\.exe\r?$/gm)];
 check(matches.length===1,'missing-or-duplicate-checksum');
 return matches[0][1].toLowerCase();
}
function createUpdater({app,fetch:fetcher=globalThis.fetch,log=()=>{},now=Date.now,probe=probeVersion,armoredKey}={}) {
 const root=path.join(app.getPath('userData'),'media-tools','yt-dlp-updates'),stateFile=path.join(root,'state.json');
 let lastAttempt=0;
 const baseVersions = new Map();
 async function baseVersion(file){let key=file;try{const st=fs.statSync(file);key+='|'+st.size+'|'+st.mtimeMs}catch{}if(!baseVersions.has(key))baseVersions.set(key,Promise.resolve().then(()=>probe(file)).catch(()=>null));return baseVersions.get(key)}
 const verify=(s,g)=>verifyChecksumSignature(s,g,armoredKey);
 const dir=r=>path.join(root,r.sha256);
 function readState(){try{check(fs.statSync(stateFile).size<=16384,'oversized-state');const s=JSON.parse(fs.readFileSync(stateFile,'utf8'));return {active:record(s.active),previous:record(s.previous),lastChecked:Number(s.lastChecked)||0,lastAttempt:Number(s.lastAttempt)||0}}catch{return {active:null,previous:null,lastChecked:0,lastAttempt:0}}}
 function writeState(state){fs.mkdirSync(root,{recursive:true});const tmp=stateFile+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,stateFile)}finally{try{fs.unlinkSync(tmp)}catch{}}}
 async function usable(r){if(!r)return false;try{const d=dir(r);check(fs.statSync(path.join(d,'SHA2-256SUMS')).size<=512*1024&&fs.statSync(path.join(d,'SHA2-256SUMS.sig')).size<=64*1024,'oversized-cached-proof');const s=fs.readFileSync(path.join(d,'SHA2-256SUMS')),sig=fs.readFileSync(path.join(d,'SHA2-256SUMS.sig'));const expected=await verify(s,sig);check(expected===r.sha256,'cached-proof-mismatch');const f=path.join(d,'yt-dlp.exe');check(fs.statSync(f).size===r.size,'cached-size-mismatch');const b=fs.readFileSync(f);checkPe(b);return sha(b)===expected}catch{return false}}
 async function body(url,limit,signal,size,onBytes){const r=await fetcher(url,{signal,redirect:'follow',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{'User-Agent':'alloconnect-yt-dlp-updater','Accept':url===API?'application/vnd.github+json':'application/octet-stream'}});check(r.ok,'upstream-http');check(!r.url||new URL(r.url).protocol==='https:','insecure-update-redirect');const chunks=[];let total=0;check(!(Number(r.headers?.get?.('content-length'))>limit),'response-too-large');for await(const b of r.body){check(!signal.aborted,'update-timeout');total+=b.length;check(total<=limit&&(size==null||total<=size),'response-too-large');chunks.push(Buffer.from(b));onBytes?.(total)}check(size==null||total===size,'truncated-download');return Buffer.concat(chunks)}
 function asset(release,name,max){const matches=release.assets.filter(a=>a&&a.name===name);check(matches.length===1,'missing-or-duplicate-asset');const a=matches[0];check(Number.isSafeInteger(a.size)&&a.size>0&&a.size<=max,'invalid-asset-size');if(a.digest!=null)check(/^sha256:[a-f0-9]{64}$/.test(a.digest),'invalid-asset-digest');return a}
 function digest(bytes,a){if(a.digest)check('sha256:'+sha(bytes)===a.digest,'asset-digest-mismatch')}
 function cleanup(state){try{for(const n of fs.readdirSync(root)){if(!SHA.test(n)||[state.active?.sha256,state.previous?.sha256].includes(n))continue;const d=path.resolve(root,n);if(path.dirname(d)!==path.resolve(root))continue;try{fs.rmSync(d,{recursive:true,force:true})}catch{}}}catch{}}
 async function update({fallback,progress=()=>{}}){
  check(typeof fallback==='string'&&path.isAbsolute(fallback),'invalid-fallback-path');
  const state=readState();let current=null;
  if(await usable(state.active))current=state.active;
  else if(await usable(state.previous))current=state.previous;
  const bundledVersion=await baseVersion(fallback);
  const preferBundled=bundledVersion&&(!current||compareVersion(bundledVersion,current.version)>0);
  const fallbackPath=current&&!preferBundled?path.join(dir(current),'yt-dlp.exe'):fallback;
  const installedVersion=preferBundled?bundledVersion:current?.version||bundledVersion;
  const time=now(),recent=(t,ms)=>Number.isFinite(t)&&t>0&&t<=time&&time-t<ms;
  const damaged=!!state.active&&current!==state.active;
  if(!damaged&&recent(state.lastChecked,CHECK_MS)||recent(Math.max(lastAttempt,state.lastAttempt),RETRY_MS))return {path:fallbackPath,version:installedVersion||null,updated:false};
  const emit=d=>{try{progress(d)}catch{}};
  const note=(event,extra={})=>{try{log('youtube-updater',{event,...extra})}catch{}};
  let pending=null,timer;const controller=new AbortController();
  try{
   emit({stage:'checking',message:'Проверка обновления yt-dlp…'});
   lastAttempt=time;
   writeState({...state,active:current,previous:current?.sha256===state.active?.sha256?state.previous:null,lastChecked:damaged?0:state.lastChecked,lastAttempt:time});
   timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);timer.unref?.();
   const release=JSON.parse((await body(API,1024*1024,controller.signal)).toString('utf8'));
   check(release&&release.draft===false&&release.prerelease===false&&VERSION.test(release.tag_name)&&Array.isArray(release.assets),'invalid-stable-release');
   const version=release.tag_name;
   const installed=installedVersion;
   if(installed&&compareVersion(version,installed)<=0){writeState({...state,active:current,previous:current?.sha256===state.active?.sha256?state.previous:null,lastChecked:time,lastAttempt:time});emit({stage:'ready',message:'yt-dlp '+installed+' — обновление не требуется'});note('checked',{version:installed});return {path:fallbackPath,version:installed,updated:false};}
   const exe=asset(release,'yt-dlp.exe',MAX_EXE),sumAsset=asset(release,'SHA2-256SUMS',512*1024),sigAsset=asset(release,'SHA2-256SUMS.sig',64*1024),base=BASE+encodeURIComponent(version)+'/';
   const sums=await body(base+'SHA2-256SUMS',512*1024,controller.signal,sumAsset.size),sig=await body(base+'SHA2-256SUMS.sig',64*1024,controller.signal,sigAsset.size);
   digest(sums,sumAsset);digest(sig,sigAsset);
   emit({stage:'verify',message:'Проверка подписи разработчиков yt-dlp…'});
   const expected=await verify(sums,sig);if(exe.digest)check(exe.digest==='sha256:'+expected,'checksum-metadata-mismatch');
   fs.mkdirSync(root,{recursive:true});pending=fs.mkdtempSync(path.join(root,'pending-'));
   emit({stage:'download',got:0,total:exe.size,message:'Обновление yt-dlp до '+version+'…'});
   const bytes=await body(base+'yt-dlp.exe',MAX_EXE,controller.signal,exe.size,got=>emit({stage:'download',got,total:exe.size,message:'Обновление yt-dlp до '+version+'…'}));
   emit({stage:'verify',message:'Проверка файла yt-dlp…'});check(sha(bytes)===expected,'binary-checksum-mismatch');checkPe(bytes);
   const file=path.join(pending,'yt-dlp.exe');fs.writeFileSync(file,bytes,{mode:0o700});fs.writeFileSync(path.join(pending,'SHA2-256SUMS'),sums);fs.writeFileSync(path.join(pending,'SHA2-256SUMS.sig'),sig);
   check(await probe(file)===version,'executable-version-mismatch');check(!controller.signal.aborted,'update-timeout');
   emit({stage:'install',message:'Установка yt-dlp '+version+'…'});
   const candidate={version,sha256:expected,size:exe.size},dest=dir(candidate);
   if(fs.existsSync(dest)){if(await usable(candidate)){fs.rmSync(pending,{recursive:true,force:true});pending=null}else{const old=dest+'.broken-'+crypto.randomBytes(6).toString('hex');fs.renameSync(dest,old);try{fs.renameSync(pending,dest);pending=null}finally{try{fs.rmSync(old,{recursive:true,force:true})}catch{}}}}
   else{fs.renameSync(pending,dest);pending=null}
   const next={active:candidate,previous:current&&current.sha256!==candidate.sha256?current:null,lastChecked:time,lastAttempt:time};
   writeState(next);cleanup(next);emit({stage:'ready',message:'yt-dlp обновлён до '+version});note('updated',{version});
   return {path:path.join(dest,'yt-dlp.exe'),version,updated:true};
  }catch(e){emit({stage:'ready',message:'Обновить yt-dlp сейчас не удалось — используется прежний загрузчик'});note('update-failed',{reason:typeof e.code==='string'?e.code:'network-or-validation'});return {path:fallbackPath,version:installedVersion||null,updated:false,error:typeof e.code==='string'?e.code:'network-or-validation'};}
  finally{clearTimeout(timer);controller.abort();if(pending){const d=path.resolve(pending);if(path.dirname(d)===path.resolve(root)&&path.basename(d).startsWith('pending-'))try{fs.rmSync(d,{recursive:true,force:true})}catch{}}}
 }
 return options=>{if(inflight.has(root))return inflight.get(root);const task=update(options);inflight.set(root,task);return task.finally(()=>{if(inflight.get(root)===task)inflight.delete(root)})};
}
module.exports={createUpdater,verifyChecksumSignature,compareVersion,checkPe,CHECK_MS,RETRY_MS,KEY_FINGERPRINT};
