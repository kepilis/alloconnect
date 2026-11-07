const {app,BrowserWindow,clipboard}=require('electron'),fs=require('fs'),path=require('path');require('./main.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function wav(){const b=Buffer.alloc(44+48000*2);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=0;i<48000;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*10000),44+i*2);return b}
app.whenReady().then(async()=>{const r={};try{await sleep(1400);const w=BrowserWindow.getAllWindows().find(x=>x.getTitle()==='alloconnect'),js=s=>w.webContents.executeJavaScript(s,true);const wave=[...wav()];
await js("$('btnSoundpadLobby').click();true");
await js("(async()=>{window.s1=await window.duo.soundsAdd(new Uint8Array("+JSON.stringify(wave)+"),'first.wav');window.s2=await window.duo.soundsAdd(new Uint8Array("+JSON.stringify(wave)+"),'second.wav');await window.duo.soundsCategoryCreate('Музыка');await window.duo.soundsUpdate(s1.id,{category:'Музыка'});await spLoadList();return true})()");
r.categories=await js("spCategories.includes('Музыка')&&$('spGrid').querySelectorAll('.sp-category').length===2");
await js("$('spManage').click();spSelectOne(s1.id);true");
r.editSelection=await js("spManaging&&spSelected.size===1&&$('soundpad').classList.contains('managing')&&spPlaying.size===0");
await js("spSelectOne(s2.id,true);true");r.multiSelect=await js("spSelected.size===2&&!$('spDeleteSelected').disabled");
await js("spOpenContext(200,200,s1.id);true");r.editMenu=await js("$('spContext').textContent.includes('Копировать')&&$('spContext').textContent.includes('Добавить в категорию')&&$('spContext').textContent.includes('Удалить')");
fs.writeFileSync(path.join(process.env.RESULT_DIR,'soundpad-manage.png'),(await w.webContents.capturePage()).toPNG());
const copy=await js("window.duo.soundsCopyFiles([s1.id,s2.id])");const items=await clipboard.read();const blob=items[0].types.includes('text/uri-list')?await items[0].getType('text/uri-list'):null;const uris=blob?await blob.text():'';r.nativeFileClipboard=copy.count===2&&uris.split(/\r?\n/).filter(Boolean).length===2&&uris.includes('first.wav');
r.internalPasteIds=await js("window.duo.soundsPasteCopied().then(x=>x.length===2)");r.clipboardTokenReadable=(await clipboard.readText()).startsWith('alloconnect:sounds:');
await js("spPaste()");await sleep(150);r.pasteButtons=await js("spList.length===4&&spSelected.size===2&&spList.filter(s=>s.name.includes('копия')).length===2");
await js("window.confirm=()=>true;spDelete([...spSelected])");await sleep(150);r.batchDelete=await js("spList.length===2&&spSelected.size===0");
await js("spSetManaging(false);spOpenContext(200,200,s1.id);true");r.playMenu=await js("$('spContext').textContent.includes('Воспроизвести на динамиках')&&$('spContext').textContent.includes('Воспроизвести на микрофоне')&&!$('spGrid').querySelector('input[type=checkbox]')");
await js("spPlay(s1.id,'speakers')");r.speakerPlayback=await js("spPlaying.has(s1.id)");await js("spStopAll();true");
await js("openSettings();true");r.defaultDuration=await js("$('downloadsDuration').value==='3'");await js("$('downloadsDuration').value='0';saveSettings()");r.neverHideSaved=await js("settings().downloadsDuration===0");
await js("downloadProgress({id:'duration-0',title:'Проверка',stage:'download',got:1,total:2});true");await sleep(1150);r.neverHideWorks=await js("!$('downloadsPanel').classList.contains('hidden')");
await js("$('downloadsDuration').value='1';saveSettings();$('downloadsHide').click();downloadProgress({id:'duration-1',title:'Проверка',stage:'download',got:1,total:2});true");await sleep(1150);r.oneSecondHide=await js("$('downloadsPanel').classList.contains('hidden')");
r.downloadButtonPosition=await js("(()=>{const b=$('downloadsToggle').getBoundingClientRect();return b.top>=60&&b.left>=0&&b.right<innerWidth})()");
r.presenceDots=await js("[...$('presenceMode').options].every(o=>/^[🟢🟡⚪⚫🔴]/u.test(o.textContent))&&$('presenceHint').textContent==='i'");
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
await js("(async()=>{await window.duo.stickersAddBytes(new Uint8Array("+JSON.stringify([...png])+"),'test');window.stkPack=await window.duo.stickersPackCreate('Второй');stkInvalidate();return true})()");
await sleep(150);const d=await js('window.duo.stickersList()');const source=d.packs.find(p=>p.items.length),item=source?.items[0];
if(source&&item){await js("(async()=>{await window.duo.stickersItemsEdit("+JSON.stringify(source.id)+",["+JSON.stringify(item.id)+"],'copy',stkPack.id);return true})()");const after=await js('window.duo.stickersList()');r.stickerCopy=after.packs.find(p=>p.id===d.packs.find(x=>x.name==='Второй').id)?.items.length===1;
await js("(async()=>{await window.duo.stickersItemsEdit("+JSON.stringify(source.id)+",["+JSON.stringify(item.id)+"],'move',stkPack.id);return true})()");const moved=await js('window.duo.stickersList()');r.stickerMove=moved.packs.find(p=>p.id===source.id)?.items.length===0&&moved.packs.find(p=>p.name==='Второй')?.items.length===2;
await js("closeSettings();$('lobby').classList.remove('active');$('call').classList.add('active');stkOpen('call',$('btnAttach'));stkEditMode(true);true");r.stickerEditUi=await js("STK.editing&&$('stickerPicker').classList.contains('editing')&&!$('stkEditBar').classList.contains('hidden')");r.stickerVisible=await js("(()=>{const p=$('stickerPicker'),b=p.getBoundingClientRect();return getComputedStyle(p).display!=='none'&&b.width>500&&b.height>200&&b.top>=0&&b.bottom<=innerHeight})()");}
else{r.stickerCopy=false;r.stickerMove=false;r.stickerEditUi=false}
await sleep(350);fs.writeFileSync(path.join(process.env.RESULT_DIR,'sticker-manage.png'),(await w.webContents.capturePage()).toPNG());
}catch(e){r.error=String(e.stack||e)}console.log(JSON.stringify(r,null,2));fs.writeFileSync(path.join(process.env.RESULT_DIR,'results.json'),JSON.stringify(r,null,2));app.exit(Object.values(r).every(v=>v===true)?0:1)});
