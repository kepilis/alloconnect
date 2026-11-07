const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('./main.js');
const role=process.env.ROLE,shared=process.env.SHARED,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const file=n=>path.join(shared,n),waitFile=async(n,ms=60000)=>{for(let i=0;i<ms/200;i++){if(fs.existsSync(file(n)))return fs.readFileSync(file(n),'utf8');await sleep(200)}throw Error('timeout '+n)};
const wait=async(js,expr,ms=60000)=>{for(let i=0;i<ms/250;i++){if(await js(expr))return true;await sleep(250)}return false};
app.whenReady().then(async()=>{const r={role};try{await sleep(2200);const w=BrowserWindow.getAllWindows().find(x=>x.getTitle()==='alloconnect'),js=s=>w.webContents.executeJavaScript(s,true);r.identity=await wait(js,'!!myIdent',15000);
await js(`$('nick').value=${JSON.stringify(role)};S.nick=${JSON.stringify(role)};true`);
if(role==='host'){
  r.started=await js('grpStart()');
  await js("$('frGroupManualCreate').click();true");
  r.offerReady=await wait(js,"$('frGroupManualOffer').value.startsWith('ALOGI.')",30000);
  const offer=await js("$('frGroupManualOffer').value");r.offer=offer.startsWith('ALOGI.');fs.writeFileSync(file('offer.txt'),offer);
  const answer=await waitFile('answer.txt');await js(`$('frGroupManualAnswer').value=${JSON.stringify(answer)};$('frGroupManualApply').click();true`);
}else{
  const offer=await waitFile('offer.txt');await js(`$('codeEntry').value=${JSON.stringify(offer)};$('codeEntry').dispatchEvent(new Event('input'));true`);
  r.codeRecognized=await wait(js,"!$('codeEntryGo').disabled&&$('codeEntryPreview').textContent.includes('в группу')",10000);
  await js("$('codeEntryGo').click();true");
  r.answerReady=await wait(js,"$('groupManualReplyCode').value.startsWith('ALOGA.')",30000);
  const answer=await js("$('groupManualReplyCode').value");r.answer=answer.startsWith('ALOGA.');fs.writeFileSync(file('answer.txt'),answer);
}
r.connected=await wait(js,'G.active&&[...G.peers.values()].some(p=>p.connected)',60000);
r.members=await js('G.members.size');r.noFriend=await js('[...G.members.keys()].filter(id=>id!==grpMe()).every(id=>!isFriend(id))');
}catch(e){r.error=String(e.stack||e)}fs.writeFileSync(file(role+'.json'),JSON.stringify(r,null,2));app.exit(r.identity&&r.offerReady!==false&&r.codeRecognized!==false&&r.answerReady!==false&&r.offer!==false&&r.answer!==false&&r.connected&&r.members===2&&r.noFriend?0:1)});
