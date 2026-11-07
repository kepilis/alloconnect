'use strict';
const fs=require('fs'),path=require('path'),{execFile}=require('child_process');
const BROWSERS=new Set(['auto','chrome','edge','firefox','brave','opera','vivaldi']);
function browserFromProgId(value){const s=String(value).toLowerCase();if(s.includes('firefox'))return 'firefox';if(s.includes('brave'))return 'brave';if(s.includes('vivaldi'))return 'vivaldi';if(s.includes('opera'))return 'opera';if(s.includes('msedge'))return 'edge';if(s.includes('chrome'))return 'chrome';return null}
function defaultBrowser(){if(process.platform!=='win32')return Promise.resolve(null);return new Promise(resolve=>execFile('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice','/v','ProgId'],{windowsHide:true,timeout:5000,encoding:'utf8'},(e,out)=>resolve(e?null:browserFromProgId(out))))}
function cookieArgs(config,detected){if(config.enabled!==true)return [];if(!BROWSERS.has(config.browser))throw Error('Выбери поддерживаемый браузер');const browser=config.browser==='auto'?detected:config.browser;if(!browser||!BROWSERS.has(browser)||browser==='auto')throw Error('Не удалось определить браузер по умолчанию. Выбери браузер в настройках YouTube.');return ['--cookies-from-browser',browser]}
function registerAuth({ipcMain,app,dialog,BrowserWindow}){
 const file=path.join(app.getPath('userData'),'youtube-auth.json');
 function read(){try{const d=JSON.parse(fs.readFileSync(file,'utf8'));return {enabled:d.enabled===true,browser:BROWSERS.has(d.browser)?d.browser:'auto'}}catch{return {enabled:false,browser:'auto'}}}
 async function status(){return {...read(),detected:await defaultBrowser()}}
 ipcMain.handle('youtube-auth-get',status);
 ipcMain.handle('youtube-auth-set',async(e,value)=>{
  const current=read();if(!value||typeof value.enabled!=='boolean'||!BROWSERS.has(value.browser))return {...await status(),error:'Неверный браузер'};
  if(value.enabled&&(!current.enabled||current.browser!==value.browser)){
   const owner=BrowserWindow.fromWebContents(e.sender),options={type:'question',message:'Использовать вход в YouTube из браузера?',detail:'yt-dlp прочитает локальные куки выбранного браузера для загрузки YouTube. Пароль вводить не нужно. Куки не сохраняются отдельным файлом, не передаются собеседнику и не записываются в лог. Доступ можно отключить здесь в любой момент.',buttons:['Разрешить','Отмена'],defaultId:1,cancelId:1,noLink:true};
   const answer=await (owner&&!owner.isDestroyed()?dialog.showMessageBox(owner,options):dialog.showMessageBox(options));if(answer.response!==0)return status();
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({enabled:value.enabled,browser:value.browser}),{mode:0o600});return status();
 });
 return {args:async()=>{const config=read();return cookieArgs(config,config.enabled&&config.browser==='auto'?await defaultBrowser():null)}};
}
module.exports={registerAuth,cookieArgs,browserFromProgId};
