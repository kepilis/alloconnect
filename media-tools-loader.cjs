'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFile}=require('child_process');
const config=require('./media-tools.json');
async function hash(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex')}
async function valid(dir){try{for(const[n,f]of Object.entries(config.files)){const p=path.join(dir,n);if(fs.statSync(p).size!==f.size||await hash(p)!==f.sha256)return false}return true}catch{return false}}
let prepared;
async function prepareTools({app,ask,fetch,progress=()=>{}}){
 if(prepared)return prepared;
 const job=(async()=>{
  progress({stage:'checking'});
  const local=path.join(__dirname,'vendor','media-tools');if(await valid(local)){progress({stage:'ready'});return local;}
  const parent=path.join(app.getPath('userData'),'media-tools'),dest=path.join(parent,config.sha256.slice(0,20));
  if(await valid(dest)){progress({stage:'ready'});return dest;}
  const answer=await ask({type:'question',message:'Скачать инструменты для YouTube?',detail:`Один раз нужно скачать ${Math.ceil(config.size/1048576)} МБ с GitHub alloconnect. Пакет проверяется перед запуском.`,buttons:['Скачать','Отмена'],defaultId:0,cancelId:1,noLink:true});if(answer.response!==0){progress({stage:'cancelled'});return null;}
  fs.mkdirSync(parent,{recursive:true});const tmp=fs.mkdtempSync(path.join(parent,'download-'));
  try{
   progress({stage:'download',got:0,total:config.size});
   const zip=path.join(tmp,'tools.zip'),r=await fetch(config.url,{signal:AbortSignal.timeout(10*60*1000)});if(!r.ok)throw Error('Не удалось скачать инструменты YouTube: '+r.status);
   let got=0,last=0;const fd=fs.openSync(zip,'wx');try{for await(const b of r.body){got+=b.length;if(got>config.size)throw Error('Неверный размер пакета YouTube');fs.writeSync(fd,b);if(Date.now()-last>200){last=Date.now();progress({stage:'download',got,total:config.size})}}}finally{fs.closeSync(fd)}
   progress({stage:'verify',got,total:config.size});
   if(got!==config.size||await hash(zip)!==config.sha256)throw Error('Проверка пакета YouTube не прошла');
   progress({stage:'install'});
   await new Promise((resolve,reject)=>execFile('tar.exe',['-xf',zip,'-C',tmp],{windowsHide:true,timeout:120000},e=>e?reject(Error('Не удалось распаковать инструменты YouTube')):resolve()));
   if(!await valid(tmp))throw Error('Повреждены инструменты YouTube');
   fs.mkdirSync(dest,{recursive:true});for(const n of Object.keys(config.files))fs.copyFileSync(path.join(tmp,n),path.join(dest,n));
   progress({stage:'ready'});
   return dest;
  }catch(e){progress({stage:'error',message:e.message});throw e}finally{fs.rmSync(tmp,{recursive:true,force:true})}
 })();prepared=job;
 try{const result=await job;if(!result)prepared=null;return result}catch(e){prepared=null;throw e}
}
module.exports={prepareTools};
