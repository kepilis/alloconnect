'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const {registerAuth}=require('./youtube-auth.cjs');
const {prepareTools}=require('./media-tools-loader.cjs');
const MAX = 512 * 1048576;
function youtubeUrl(raw) {
  const u = new URL(String(raw));
  if (u.protocol !== 'https:' || !/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/.test(u.hostname)) throw Error('Нужна ссылка YouTube');
  if (u.hostname.endsWith('youtu.be')) { const id = u.pathname.slice(1); if (!/^[\w-]{11}$/.test(id)) throw Error('Нужна ссылка на одно видео'); return 'https://www.youtube.com/watch?v=' + id; }
  const id = u.searchParams.get('v') || /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(u.pathname)?.[1];
  if (!/^[\w-]{11}$/.test(id || '')) throw Error('Нужна ссылка на одно видео');
  return 'https://www.youtube.com/watch?v=' + id;
}
function mediaError(e, stderr = '') {
  const text=String(stderr);
  let code='download-failed',message='Не удалось получить медиа. Проверь доступ к YouTube и обновление yt-dlp.';
  if (/failed to decrypt|decrypt.*cookies|DPAPI|app.bound/i.test(text)) { code='cookies-protected'; message='Не удалось расшифровать куки браузера. Его защита не позволяет yt-dlp прочитать вход. Выбери другой поддерживаемый браузер, где выполнен вход в YouTube.'; }
  else if (/could not copy.*cookie|cookie.*database.*locked|permission denied.*cookies/i.test(text)) { code='cookies-locked'; message='Браузер заблокировал доступ к куки. Полностью закрой выбранный браузер и повтори загрузку.'; }
  else if (/could not find.*cookies|could not find.*profile|could not find.*database/i.test(text)) { code='cookies-missing'; message='Профиль браузера не найден. Открой выбранный браузер, войди в YouTube или выбери другой браузер в настройках.'; }
  else if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(text)) { code='age-restricted'; message='У этого видео возрастное ограничение YouTube. Для загрузки требуется вход в аккаунт и подтверждение возраста. Включи использование входа из браузера в настройках YouTube и убедись, что нужный аккаунт имеет доступ к видео.'; }
  else if (/sign in|login required|members.only|private video/i.test(text)) { code='login-required'; message='Для этого видео YouTube требует вход в аккаунт. Загрузчик alloconnect сейчас работает без авторизации.'; }
  else if (/video.*unavailable|removed|not available in your country/i.test(text)) { code='unavailable'; message='YouTube сообщает, что видео недоступно или ограничено для текущего региона.'; }
  else if (/requested format is not available/i.test(text)) { code='format-unavailable'; message='YouTube не предоставил подходящий видеоформат для этого ролика.'; }
  else if (/429|too many requests/i.test(text)) { code='rate-limited'; message='YouTube временно ограничил запросы. Попробуй позже.'; }
  else if (e?.killed || e?.code==='ETIMEDOUT') { code='timeout'; message='YouTube не ответил вовремя. Попробуй ещё раз.'; }
  const error=Error(message);error.mediaCode=code;return error;
}
function run(exe,args,timeout=120000,onProgress) {
  return new Promise((resolve,reject) => {
    const child=execFile(exe,args,{windowsHide:true,timeout,maxBuffer:8*1048576,encoding:'utf8'},(e,out,stderr)=>e?reject(mediaError(e,stderr)):resolve(out));
    let pending='';const parse=chunk=>{pending+=String(chunk);const lines=pending.split(/\r?\n/);pending=lines.pop().slice(-1024);for(const line of lines){const m=/^ALO_PROGRESS:(\d+):(\d+|NA)$/.exec(line.trim());if(m)onProgress?.({stage:'download',got:Number(m[1]),total:m[2]==='NA'?0:Number(m[2])})}};
    child?.stdout?.on('data',parse);
  });
}
function register({ipcMain,app,dialog,BrowserWindow,net,log}) {
  const auth=registerAuth({ipcMain,app,dialog,BrowserWindow});
  let busy = false, preparedDir=null;
  const toolCache = new Map();
  const tool = name => {
    if(preparedDir)return path.join(preparedDir,name+'.exe');
    if (toolCache.has(name)) return toolCache.get(name);
    const bundled = path.join(process.resourcesPath,'media-tools',name + '.exe');
    const dev = path.join(__dirname,'vendor','media-tools',name + '.exe');
    let result = fs.existsSync(bundled)?bundled:fs.existsSync(dev)?dev:name;
    if (result.includes('app.asar' + path.sep)) {
      const dir = path.join(app.getPath('userData'),'media-tools');
      fs.mkdirSync(dir,{recursive:true});
      const target = path.join(dir,name+'.exe');
      fs.copyFileSync(result,target+'.tmp'); fs.renameSync(target+'.tmp',target);
      result = target;
    }
    toolCache.set(name,result); return result;
  };
  ipcMain.handle('youtube-media', async (e,raw) => {
    if (busy) return {error:'Дождись предыдущей загрузки YouTube'};
    busy = true; let tmp;
    const progress=data=>{try{e.sender.send('download-progress',data)}catch{}};
    let mediaStage=null;
    const mediaProgress=data=>{mediaStage=data.stage;progress({id:'youtube-media',title:'Медиа с YouTube',...data})};
    try {
      const url = youtubeUrl(raw), owner = BrowserWindow.fromWebContents(e.sender);
      const ask = options => owner && !owner.isDestroyed()?dialog.showMessageBox(owner, options):dialog.showMessageBox(options);
      const choice = await ask({type:'question',message:'Добавить как?',buttons:['Видео','Звук','Отмена'],cancelId:2,defaultId:0,noLink:true});
      if (choice.response === 2) return {cancelled:true};
      const audio = choice.response === 1;
      mediaProgress({stage:'starting',message:'Подготовка загрузчика…'});
      preparedDir=await prepareTools({app,ask,fetch:net?.fetch?.bind(net)||globalThis.fetch,progress:data=>progress({id:'youtube-tools',title:'Инструменты YouTube',...data})});
      if(!preparedDir){mediaProgress({stage:'cancelled'});return {cancelled:true};}
      tool('ffprobe');
      mediaProgress({stage:'starting',message:'Получение информации о видео…'});
      const cookies=await auth.args();
      const base = [...cookies,'--js-runtimes','node:'+tool('node'),'--ignore-config','--no-playlist','--no-warnings','--no-progress','--no-cache-dir','--no-write-info-json','--no-write-thumbnail','--socket-timeout','20','--retries','2','--ffmpeg-location',tool('ffmpeg')];
      const format = audio?'bestaudio[ext=m4a]/bestaudio':'bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]';
      const info = JSON.parse(await run(tool('yt-dlp'),[...base,'-f',format,'--dump-single-json','--skip-download','--',url]));
      if (info.is_live || info.duration > 21600) { const message='Прямой эфир или видео длиннее 6 часов не поддерживается'; mediaProgress({stage:'error',message}); return {error:message}; }
      const tracks = info.requested_formats || [info];
      const known = tracks.every(t => Number(t.filesize || t.filesize_approx)>0);
      const size = tracks.reduce((n,t)=>n+Number(t.filesize || t.filesize_approx || 0),0);
      if (size>MAX) { const message='Медиа больше 512 МБ — выбери более короткое видео'; mediaProgress({stage:'error',message}); return {error:message}; }
      let largeApproved = false;
      if (!known || size > 100*1048576) {
        const result = await ask({type:'question',message:known?`Медиа примерно ${Math.ceil(size/1048576)} МБ — больше 100 МБ. Загрузить?`:'Размер заранее неизвестен: медиа может быть больше 100 МБ. Загрузить?',detail:'Максимальный размер — 512 МБ.',buttons:['Да','Нет'],defaultId:1,cancelId:1,noLink:true});
        if (result.response !== 0) return {cancelled:true};
        largeApproved = true;
      }
      tmp = fs.mkdtempSync(path.join(app.getPath('temp'),'alloconnect-youtube-'));
      const output = path.join(tmp,'media.%(ext)s');
      mediaProgress({stage:'download',got:0,total:size});
      await run(tool('yt-dlp'),[...base,'--newline','--progress','--progress-template','download:ALO_PROGRESS:%(progress.downloaded_bytes)s:%(progress.total_bytes,progress.total_bytes_estimate)s','-f',format,'--max-filesize',String(MAX),'--merge-output-format','mp4','-o',output,...(audio?['-x','--audio-format','mp3']:[]),'--',url],20*60*1000,mediaProgress);
      mediaProgress({stage:'processing',message:'Подготовка медиафайла…'});
      const file = fs.readdirSync(tmp).find(n=>audio?/\.mp3$/.test(n):/\.(mp4|webm|mkv)$/.test(n));
      if (!file) { const message='Загрузка не завершилась или медиа превышает 512 МБ'; mediaProgress({stage:'error',message}); return {error:message}; }
      const p = path.join(tmp,file), actual = fs.statSync(p).size;
      if (actual>MAX) { const message='Медиа больше 512 МБ'; mediaProgress({stage:'error',message}); return {error:message}; }
      if (actual>100*1048576 && !largeApproved) {
        const answer = await ask({type:'question',message:`Медиа ${Math.ceil(actual/1048576)} МБ — больше 100 МБ. Добавить?`,buttons:['Да','Нет'],defaultId:1,cancelId:1,noLink:true});
        if (answer.response!==0) return {cancelled:true};
        largeApproved=true;
      }
      const ext = path.extname(file);
      mediaProgress({stage:'ready',message:'Файл загружен — можно добавлять'});
      return {bytes:fs.readFileSync(p),name:String(info.title || 'YouTube').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,100)+ext,mime:audio?'audio/mpeg':ext==='.webm'?'video/webm':ext==='.mkv'?'video/x-matroska':'video/mp4',largeApproved};
    } catch (err) { mediaProgress({stage:'error',message:err.message}); log?.('youtube',{error:err.mediaCode||'prepare-failed'}); return {error:err.message}; }
    finally { if(mediaStage&&!['ready','error','cancelled'].includes(mediaStage))mediaProgress({stage:'cancelled',message:'Загрузка остановлена'}); busy=false; if (tmp) fs.rmSync(tmp,{recursive:true,force:true}); }
  });
}
module.exports = {register,youtubeUrl,mediaError};
