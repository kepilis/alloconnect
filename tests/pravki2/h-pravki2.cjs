
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');require('./main.js');const sleep=ms=>new Promise(r=>setTimeout(r,ms));app.whenReady().then(async()=>{const r={};try{await sleep(1500);const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='alloconnect'),js=s=>w.webContents.executeJavaScript(s,true);
fs.writeFileSync(path.join(process.env.RESULT_DIR,'code-entry-home.png'),(await w.webContents.capturePage()).toPNG());
const crypto=require('crypto');const {encodeFriendCode}=require('./net-friends.js');
const friendCode=encodeFriendCode({id:crypto.randomBytes(32).toString('base64url'),tok:crypto.randomBytes(12).toString('hex'),nick:'Друг',addrs:[{kind:'lan',ip:'192.168.1.2',port:31337}]});
await js("$('codeEntry').value="+JSON.stringify(friendCode)+";$('codeEntry').dispatchEvent(new Event('input'));true");await sleep(150);
r.codeEntryFriendPreview=await js("!$('codeEntryGo').disabled&&$('codeEntryPreview').textContent.includes('Друг')");
await js("$('codeEntryGo').click();true");r.codeEntryFriendRoute=await js("!$('fcModal').classList.contains('hidden')&&$('fcIn').value.startsWith('ALOF.')");
await js("$('fcClose').click();$('codeEntry').value='';$('codeEntry').dispatchEvent(new Event('input'));true");
const invite=await js("packCode('I','v=0\\n'+Array.from({length:400},()=>Math.random().toString(36)).join('\\n'),'Гость')");
await js("$('codeEntry').value="+JSON.stringify(invite)+";$('codeEntry').dispatchEvent(new Event('input'));true");await sleep(150);
r.codeEntryInvitePreview=await js("!$('codeEntryGo').disabled&&$('codeEntryPreview').textContent.includes('Гость')");
await js("$('codeEntryGo').click();true");r.codeEntryInviteRoute=await js("document.querySelector('.step.active').id==='stepGuest'&&$('offerIn').value.startsWith('ALOI.')&&!S.inCall");
await js("showStep('stepHome');$('codeEntry').value='';$('codeEntry').dispatchEvent(new Event('input'));true");
const answer=await js("packCode('A','v=0\\n'+Array.from({length:400},()=>Math.random().toString(36)).join('\\n'),'Гость')");
await js("$('codeEntry').value="+JSON.stringify(answer)+";$('codeEntry').dispatchEvent(new Event('input'));true");await sleep(150);
r.codeEntryAnswerGuard=await js("$('codeEntryGo').disabled&&$('codeEntryPreview').textContent.includes('ответ')");
r.lobbyClean=await js("$('btnSettingsLobby').textContent==='Настройки'&&!$('btnOpenLogsLobby')&&!document.querySelector('.test-note')");
r.youtubeNested=await js("$('youtubeAuthBrowser').closest('[data-cat=screen]')!==null");
await js("downloadProgress({id:'one',stage:'download',got:1,total:10});true");await sleep(1200);r.autoHides=await js("$('downloadsPanel').classList.contains('hidden')");
await js("$('downloadsToggle').click();true");await sleep(1200);r.manualStaysOpen=await js("!$('downloadsPanel').classList.contains('hidden')");
await js("downloadProgress({id:'done',stage:'ready'});$('downloadsClear').click();true");r.clearKeepsActive=await js("document.querySelectorAll('.download-row').length===1&&document.querySelector('.download-row').dataset.downloadId==='one'");
await js("$('downloadsHide').click();store.set('settings',{...settings(),downloadsAuto:false});downloadProgress({id:'two',stage:'download'});true");r.optOut=await js("$('downloadsPanel').classList.contains('hidden')");
await js("openSettings()");await sleep(150);await js("$('settings').click();true");r.settingsBackdropCloses=await js("$('settings').classList.contains('hidden')");
await js("$('btnSoundpadLobby').click();true");await sleep(100);r.padOpensWithoutCall=await js("!$('soundpad').classList.contains('hidden')&&!S.inCall");
await js("spList=[{id:'a',name:'Alpha',category:'Music'},{id:'b',name:'Beta',category:'Effects'}];spRender();$('spSearch').value='alp';$('spSearch').dispatchEvent(new Event('input'));true");r.soundSearch=await js("$('spGrid').children.length===1&&$('spGrid').firstChild.dataset.id==='a'");
await js("$('spSearch').value='';spRender();$('spCategory').value='Effects';$('spCategory').dispatchEvent(new Event('change'));true");r.soundCategory=await js("$('spGrid').children.length===1&&$('spGrid').firstChild.dataset.id==='b'");
await js("$('spGrid').querySelector('input').click();true");r.multiSelection=await js("spSelected.has('b')&&!$('spDeleteSelected').disabled");
await js("window.fullClicks=0;$('btnFull').onclick=()=>fullClicks++;$('remoteScreenWrap').classList.remove('hidden');document.body.focus();document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',bubbles:true}));true");r.fullscreenShortcut=await js('fullClicks===1');await js("$('chatInput').dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',bubbles:true}));true");r.typingFNotIntercepted=await js('fullClicks===1');

await js("window.testId='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';window.duo.appSettingsSet({saveChatFiles:false})");r.noFileSavedWhenOff=await js("window.duo.histMediaSave(testId,new Uint8Array([1,2,3]),'test.txt').then(x=>x===null)");await js("window.duo.appSettingsSet({saveChatFiles:true})");r.fileSavedWhenOn=await js("window.duo.histMediaSave(testId,new Uint8Array([1,2,3]),'test.txt').then(async rel=>rel.startsWith('media/')&&(await window.duo.histMediaRead(testId,rel)).length===3)");
await js("(async()=>{window.added1=await window.duo.soundsAdd(new Uint8Array([1,2,3]),'one.wav');window.added2=await window.duo.soundsAdd(new Uint8Array([4,5,6]),'two.wav');await window.duo.soundsUpdate(added1.id,{category:'Music'});$('spSearch').value='';$('spCategory').value='';await spLoadList();return true})()");r.categoryPersists=await js("spList.find(s=>s.id===added1.id).category==='Music'");await js("(async()=>{window.confirm=()=>true;spSelected.clear();spSelected.add(added1.id);spSelected.add(added2.id);await $('spDeleteSelected').onclick();return true})()");r.batchRemovesStoredSounds=await js("window.duo.soundsList().then(d=>spList.length===0&&d.list.length===0)");
await js("store.set('settings',{...settings(),downloadsAuto:true});downloadProgress({id:'one',stage:'ready'});$('downloadsToggle').click();applyTheme('retro98');true");await sleep(200);fs.writeFileSync(path.join(process.env.RESULT_DIR,'retro98.png'),(await w.webContents.capturePage()).toPNG());
await js("window.duo.uiScale(1.25);openSettings()");await sleep(200);r.scaleApplied=w.webContents.getZoomFactor()===1.25;r.settingsAbovePad=await js("Number(getComputedStyle($('settings')).zIndex)>Number(getComputedStyle($('soundpad')).zIndex)");
for(const theme of ['retro98','notebook','newspaper','nord','linen']){await js('applyTheme('+JSON.stringify(theme)+');true');await sleep(180);fs.writeFileSync(path.join(process.env.RESULT_DIR,theme+'-settings-125.png'),(await w.webContents.capturePage()).toPNG())}
await js("closeSettings();window.duo.ovlOpen('screen:fixture')");await sleep(200);const ov=BrowserWindow.getAllWindows().find(x=>x.getTitle()==='alloconnect-overlay');r.overlayUnscaled=ov.webContents.getZoomFactor()===1;await js('window.duo.ovlClose()');
}catch(e){r.error=String(e.stack||e)}console.log(JSON.stringify(r,null,2));fs.writeFileSync(path.join(process.env.RESULT_DIR,'results.json'),JSON.stringify(r,null,2));app.exit(Object.values(r).every(v=>v===true)?0:1)});
