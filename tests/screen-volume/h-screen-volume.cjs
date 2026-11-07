const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');require('./main.js');
app.whenReady().then(async()=>{const r={phase:process.env.PHASE};try{
  await new Promise(resolve=>setTimeout(resolve,1300));
  const w=BrowserWindow.getAllWindows().find(x=>x.getTitle()==='alloconnect');
  const js=s=>w.webContents.executeJavaScript(s,true);
  if(process.env.PHASE==='first'){
    r.defaultVolume=await js("$('screenVol').value==='100'");
    r.saved=await js("$('screenVol').value='42';$('screenVol').dispatchEvent(new Event('input'));store.get('screenVol',null)===42&&$('remoteScreen').volume===0.42");
  }else{
    r.restored=await js("$('screenVol').value==='42'&&store.get('screenVol',null)===42");
    r.applied=await js("stopDuck();$('remoteScreen').volume===0.42");
  }
}catch(e){r.error=String(e.stack||e)}
fs.writeFileSync(path.join(process.env.RESULT_DIR,process.env.PHASE+'.json'),JSON.stringify(r,null,2));console.log(JSON.stringify(r));app.exit(Object.entries(r).filter(([k])=>k!=='phase').every(([,v])=>v===true)?0:1)});
