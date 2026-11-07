const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const src=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alc-replay-')),app=path.join(tmp,'app');fs.mkdirSync(app);
const from=process.env.APP_FROM||src;
for(const n of fs.readdirSync(from))if(!['node_modules','tests','dist','.git'].includes(n))fs.cpSync(path.join(from,n),path.join(app,n),{recursive:true,filter:p=>!p.replace(/\\/g,'/').includes('/vendor/media-tools')});
fs.copyFileSync(path.join(__dirname,'h-replay.cjs'),path.join(app,'h-replay.cjs'));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'alc-replay-test',version:'1.21.6',main:'h-replay.cjs'}));
const fixture=path.join(tmp,'replay.mp4');
const gen=spawnSync(path.join(src,'vendor/media-tools/ffmpeg.exe'),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-f','lavfi','-i','sine=frequency=440','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',fixture]);if(gen.status!==0)throw Error(String(gen.stderr));
const r=spawnSync(require(path.join(src,'node_modules/electron')),['--no-sandbox',app],{env:{...process.env,ALOCALLS_USERDATA:path.join(tmp,'ud'),REPLAY_FIXTURE:fixture,RESULT_DIR:tmp},encoding:'utf8',timeout:90000});console.log(r.stdout,r.stderr,'Artifacts:',tmp);process.exit(r.status??1);
