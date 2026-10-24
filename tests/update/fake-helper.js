const fs=(()=>{try{return require('original-fs')}catch{return require('fs')}})();
const mode=process.argv[2];
if(mode==='apply'||mode==='swap'){
  // args: apply result pid appexe [src dst]...  | swap result pid appexe [file]...
  const result=process.argv[3];
  try{
    if(mode==='apply'){ for(let i=6;i+1<process.argv.length;i+=2){ fs.copyFileSync(process.argv[i],process.argv[i+1]); } }
    fs.writeFileSync(result,'ok');
  }catch(e){ try{fs.writeFileSync(result,'err '+e.message)}catch{} }
  process.exit(0);
}
if(mode==='keys'||mode==='fg'){ process.stdout.write('OK\n'); setInterval(()=>{},1e9); }
else if(mode==='input'){ process.stdout.write('OK\n'); setInterval(()=>{},1e9); }
else { process.stderr.write('OK\n'); setInterval(()=>{},1e9); }
process.stdin.resume();
