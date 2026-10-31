const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=process.env.ALLOCONNECT_DESKTOP||'C:/Users/user/Desktop/claude/alloconnect-src';
const source=fs.readFileSync(path.join(root,'main.js'),'utf8');
const part=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const functions=part('function verCmp(', 'let ownUpdate =')+part('async function ghCheck()', "ipcMain.handle('gh-check'");
const keys=crypto.generateKeyPairSync('ed25519'),head='a'.repeat(40),files=['app.asar','alloconnect-helper.exe'];
const data=Object.fromEntries(files.map(n=>[n,Buffer.from('trusted fixture '+n)]));
const manifest={app:'alloconnect',v:'99.0.0',electron:'test',files:files.map(n=>({n,size:data[n].length,sha256:crypto.createHash('sha256').update(data[n]).digest('hex')}))};
const m=JSON.stringify(manifest),sig=crypto.sign(null,Buffer.from(m),keys.privateKey).toString('base64');
(async()=>{
 for(const scenario of ['pinned','transient-corrupt','permanent-corrupt','bad-signature','api-offline']){
  const calls=[],counts={};const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'alo-update-test-'));
  const ctx=vm.createContext({Buffer,Set,Date,JSON,path,fs,ofs:fs,crypto2:crypto,UPDATE_PUBKEY:keys.publicKey.export({type:'spki',format:'pem'}),UPDATE_FILES:files,GH_REPO:'test/repo',GH_API:'https://api.invalid',GH_RAW:'https://raw.invalid',app:{getVersion:()=> '1.0.0',isPackaged:true},process:{versions:{electron:'test'}},FAKE_HELPER:false,staged:null,stagingDir:()=>dir,log:()=>{},ghGet:async(url,json)=>{
   calls.push(url);
   if(json){if(scenario==='api-offline')throw Error('offline');return {sha:head};}
   const ref=scenario==='api-offline'?'updates':head;assert(url.includes('/'+ref+'/'),'manifest and binaries must use same immutable snapshot');
   if(url.includes('/update.json'))return Buffer.from(JSON.stringify({m,sig:scenario==='bad-signature'?'AA==':sig}));
   const n=files.find(n=>url.includes('/'+n+'?'));assert(n);counts[n]=(counts[n]||0)+1;
   if(scenario==='permanent-corrupt'||scenario==='transient-corrupt'&&counts[n]===1)return Buffer.from('corrupt');
   return data[n];
  }});
  try{
   vm.runInContext(functions,ctx);const result=await ctx.ghCheck();
   if(scenario==='permanent-corrupt'){assert.equal(result.ok,false);assert.equal(counts[files[0]],3);assert.equal(ctx.staged,null);}
   else if(scenario==='bad-signature'){assert.equal(result.ok,false);assert.equal(Object.keys(counts).length,0);}
   else {assert(result.ready);for(const n of files){assert.deepEqual(fs.readFileSync(path.join(dir,'99.0.0',n)),data[n]);assert.equal(counts[n],scenario==='transient-corrupt'?2:1);}}
   console.log('PASS update '+scenario);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
