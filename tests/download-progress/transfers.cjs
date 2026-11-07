const fs=require('fs'),vm=require('vm'),assert=require('assert');const s=fs.readFileSync(require('path').resolve(__dirname,'../../renderer.js'),'utf8'),events=[];let sizes=[];const noUi={progress(){},done(){},fail(){}};
const FC=vm.runInNewContext('('+s.slice(s.indexOf('class FileChan {'),s.indexOf('// файлы в звонке')).trim()+')',{MAX_FILE:2147483648,SVID_MAX:536870912,NOUI:noUi,Blob,ArrayBuffer,Uint8Array,DataView,cleanPlacement:()=>null,fileKind:()=> 'image',L(){},window:{downloadProgress:d=>events.push(d)}});
const c=new FC({addEventListener(){}},()=>null,{screenimg:b=>sizes.push(b.size)});
const start=(fid,size)=>c.onMsg(JSON.stringify({t:'file-start',p:'screenimg',fid,size,mime:'image/png',name:'fixture.png'})),end=fid=>c.onMsg(JSON.stringify({t:'file-end',fid})),bytes=(fid,n)=>{const b=new ArrayBuffer(4+n);new DataView(b).setUint32(0,fid);c.onMsg(b)};
start(1,4);bytes(1,2);assert(events.some(e=>e.stage==='download'&&e.got===2&&e.total===4));bytes(1,2);end(1);assert.deepEqual(sizes,[4]);assert.equal(events.at(-1).stage,'ready');
start(2,4);end(2);assert.equal(events.at(-1).stage,'error');assert.equal(sizes.length,1);
start(3,4);bytes(3,5);assert.equal(events.at(-1).stage,'error');assert(!c.incoming.has(3));
start(4,4);c.fail('Соединение прервано');assert.equal(events.at(-1).stage,'error');assert.equal(c.incoming.size,0);
console.log('PASS: actual received-byte progress; complete file ready; truncated and oversized files rejected; disconnect ends progress.');
