const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const src=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alc-screen-vol-')),dir=path.join(tmp,'app');fs.mkdirSync(dir);
for(const n of fs.readdirSync(src))if(!['node_modules','tests','dist','.git'].includes(n))fs.cpSync(path.join(src,n),path.join(dir,n),{recursive:true,filter:p=>!p.replace(/\\/g,'/').includes('/vendor/media-tools')});
fs.copyFileSync(path.join(__dirname,'h-screen-volume.cjs'),path.join(dir,'h-screen-volume.cjs'));
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'alc-screen-vol-test',version:'1.21.14',main:'h-screen-volume.cjs'}));
const electron=require(path.join(src,'node_modules/electron'));
for(const phase of ['first','second']){const p=spawnSync(electron,['--no-sandbox',dir],{env:{...process.env,PHASE:phase,RESULT_DIR:tmp,ALOCALLS_USERDATA:path.join(tmp,'ud')},encoding:'utf8',timeout:30000});console.log(p.stdout,p.stderr);if(p.status!==0){console.log('Artifacts:',tmp);process.exit(p.status??1)}}
console.log('PASS screen volume persisted across app restart');console.log('Artifacts:',tmp);
