const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const src=path.resolve(__dirname,'../..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alc-media-ui-')),app=path.join(tmp,'app');fs.mkdirSync(app);
for(const n of fs.readdirSync(src))if(!['node_modules','tests','dist','.git'].includes(n))fs.cpSync(path.join(src,n),path.join(app,n),{recursive:true,filter:p=>!p.replace(/\\/g,'/').includes('/vendor/media-tools')});
fs.copyFileSync(path.join(__dirname,'h-clip-sync.cjs'),path.join(app,'h-clip-sync.cjs'));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'alc-test',version:'1.21.6',main:'h-clip-sync.cjs'}));
const r=spawnSync(require(path.join(src,'node_modules/electron')),['--no-sandbox',app],{env:{...process.env,ALOCALLS_USERDATA:path.join(tmp,'ud'),RESULT_DIR:tmp,CLIP_PROBE:path.join(src,'vendor/media-tools/ffprobe.exe')},encoding:'utf8',timeout:90000});
console.log(r.stdout,r.stderr);console.log('Artifacts:',tmp);process.exit(r.status??1);
