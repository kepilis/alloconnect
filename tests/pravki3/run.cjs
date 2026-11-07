const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const src=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alc-pravki3-')),app=path.join(tmp,'app');fs.mkdirSync(app);
for(const n of fs.readdirSync(src))if(!['node_modules','tests','dist','.git'].includes(n))fs.cpSync(path.join(src,n),path.join(app,n),{recursive:true,filter:p=>!p.replace(/\\/g,'/').includes('/vendor/media-tools')});
fs.copyFileSync(path.join(__dirname,'h-ui.cjs'),path.join(app,'h-ui.cjs'));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'alc-pravki3-test',version:'1.21.12',main:'h-ui.cjs'}));
const electron=require(path.join(src,'node_modules/electron'));
const r=spawnSync(electron,['--no-sandbox',app],{env:{...process.env,ALOCALLS_USERDATA:path.join(tmp,'ud'),RESULT_DIR:tmp},encoding:'utf8',timeout:90000});
console.log(r.stdout,r.stderr);console.log('Artifacts:',tmp);process.exit(r.status??1);
