const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const src=path.resolve(__dirname,'../..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alc-media-ui-')),app=path.join(tmp,'app');fs.mkdirSync(app);
const from=process.env.APP_FROM||src;
for(const n of fs.readdirSync(from))if(!['node_modules','tests','dist','.git'].includes(n))fs.cpSync(path.join(from,n),path.join(app,n),{recursive:true,filter:p=>!p.replace(/\\/g,'/').includes('/vendor/media-tools')});
fs.copyFileSync(path.join(__dirname,'h-media-ui.cjs'),path.join(app,'h-media-ui.cjs'));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'alc-test',version:'1.21.6',main:'h-media-ui.cjs'}));
const ffmpeg=path.join(src,'vendor/media-tools/ffmpeg.exe');
const long=path.join(tmp,'long.mp4'),sound=path.join(tmp,'sound.mp3');
for(const args of [['-f','lavfi','-i','color=c=blue:s=160x90:r=1','-t','65','-c:v','libx264','-pix_fmt','yuv420p',long],['-f','lavfi','-i','sine=frequency=440:duration=2',sound]]){const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args]);if(r.status!==0)throw Error(String(r.stderr));}
const r=spawnSync(require(path.join(src,'node_modules/electron')),['--no-sandbox',app],{env:{...process.env,ALOCALLS_USERDATA:path.join(tmp,'ud'),RESULT_DIR:tmp,MEDIA_TEST_LONG:long,MEDIA_TEST_AUDIO:sound},encoding:'utf8',timeout:90000});
console.log(r.stdout,r.stderr);console.log('Artifacts:',tmp);process.exit(r.status??1);
