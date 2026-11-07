const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
const src=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'alc-group-manual-')),dir=path.join(tmp,'app');fs.mkdirSync(dir);
for(const n of fs.readdirSync(src))if(!['node_modules','tests','dist','.git'].includes(n))fs.cpSync(path.join(src,n),path.join(dir,n),{recursive:true,filter:p=>!p.replace(/\\/g,'/').includes('/vendor/media-tools')});
fs.copyFileSync(path.join(__dirname,'group-manual-h.cjs'),path.join(dir,'group-manual-h.cjs'));
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'alc-group-manual-test',version:'1.21.12',main:'group-manual-h.cjs'}));
const electron=require(path.join(src,'node_modules/electron'));
const run=role=>new Promise(done=>{const out=fs.openSync(path.join(tmp,role+'.log'),'w');const p=spawn(electron,['--no-sandbox',dir],{env:{...process.env,ROLE:role,SHARED:tmp,ALOCALLS_USERDATA:path.join(tmp,'ud-'+role)},stdio:['ignore',out,out]});const kill=setTimeout(()=>p.kill(),100000);p.on('exit',code=>{clearTimeout(kill);done(code)});});
Promise.all([run('host'),run('guest')]).then(codes=>{for(const role of ['host','guest']){const f=path.join(tmp,role+'.json');console.log(role,fs.existsSync(f)?fs.readFileSync(f,'utf8'):'no result');}console.log('Artifacts:',tmp);process.exit(codes.every(c=>c===0)?0:1)});
