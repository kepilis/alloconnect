const path=require('path');
const {spawn}=require('child_process'),assert=require('assert');
const helper=process.argv[2]||path.resolve(__dirname,'../../native/alloconnect-helper.exe');
const fixture=spawn(process.argv[3]||path.join(__dirname,'fixture.exe'),[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let text='',err='',volume=[];fixture.stdout.on('data',d=>{text+=d;for(const l of String(d).split(/\r?\n/)){if(l.startsWith('VOL '))volume.push(Number(l.slice(4)))}});fixture.stderr.on('data',d=>err+=d);
async function wait(pred,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(pred())return;await sleep(20)}throw Error('Timeout '+err)}
async function get(){const n=volume.length;fixture.stdin.write('get\n');await wait(()=>volume.length>n);return volume.at(-1)}
const kids=[];function start(owner){const p=spawn(helper,['duck-test',String(fixture.pid),...(owner?[String(owner)]:[])],{windowsHide:true,stdio:['pipe','ignore','pipe']});kids.push(p);p.ready=false;p.stderr.on('data',d=>{if(String(d).includes('OK'))p.ready=true;else err+=d});p.done=new Promise(r=>p.on('exit',r));p.stdin.on('error',()=>{});return p}
async function end(p){p.stdin.end();assert.equal(await p.done,0)}
(async()=>{try{await wait(()=>text.includes('READY'));const baseline=await get();assert(Math.abs(baseline-.73)<.01);const readings=[];
for(let i=0;i<5;i++){const p=start();await wait(()=>p.ready);p.stdin.write('level 0.2\n');await sleep(450);const low=await get();assert(Math.abs(low-baseline*.2)<.02,'duck '+low);await end(p);const restored=await get();assert(Math.abs(restored-baseline)<.01,'restore '+restored);readings.push({low,restored})}
const a=start();await wait(()=>a.ready);a.stdin.write('level 0.2\n');await sleep(400);const b=start();b.stdin.write('level 0.2\n');await sleep(200);assert(!b.ready,'second helper must wait');await end(a);await wait(()=>b.ready);await sleep(450);assert(Math.abs(await get()-baseline*.2)<.02,'overlap snapshot');await end(b);assert(Math.abs(await get()-baseline)<.01,'overlap restore');
const owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});const orphan=start(owner.pid);await wait(()=>orphan.ready);orphan.stdin.write('level 0.2\n');await sleep(400);owner.kill();assert.equal(await orphan.done,0);assert(Math.abs(await get()-baseline)<.01,'parent death restore');
console.log(JSON.stringify({baseline,cycles:readings,overlapSerialized:true,parentDeathRestores:true,final:await get()},null,2));}
catch(e){console.error(e);process.exitCode=1}finally{for(const p of kids)if(p.exitCode===null)p.stdin.end();await sleep(700);fixture.stdin.write('quit\n');fixture.stdin.end()}})();
