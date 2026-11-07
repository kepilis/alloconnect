const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),{EventEmitter}=require('events');
const source=fs.readFileSync(path.resolve(__dirname,'../../main.js'),'utf8').replace(/\r\n/g,'\n');
const code=source.slice(source.indexOf('let duckProc = null;'),source.indexOf('/* =========================================================\n   Удалённое управление'));
let level=1,active=0,maxActive=0,started=0;const handlers={};
function spawnHelper(){const p=new EventEmitter(),orig=level;active++;started++;maxActive=Math.max(maxActive,active);p.stderr=new EventEmitter();p.stdin=new EventEmitter();p.stdin.write=s=>{level=orig*Number(s.split(' ')[1])};p.stdin.end=()=>setTimeout(()=>{level=orig;active--;p.emit('exit',0)},60);return p}
vm.runInNewContext(code,{spawnHelper,helperUsable:()=>true,log:()=>{},setTimeout,Math,Number,process:{pid:123},ipcMain:{handle:(n,f)=>handlers[n]=f},app:{on:()=>{}}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{handlers['duck-set'](null,.2);assert.equal(level,.2);handlers['duck-stop']();handlers['duck-set'](null,.2);await sleep(100);assert.equal(level,.2);handlers['duck-stop']();await sleep(100);assert.equal(level,1);assert.equal(maxActive,1);assert.equal(started,2);console.log(JSON.stringify({rapidStopStartRestores:true,maxConcurrentHelpers:maxActive,helpersStarted:started,finalVolume:level}));})().catch(e=>{console.error(e);process.exitCode=1});
