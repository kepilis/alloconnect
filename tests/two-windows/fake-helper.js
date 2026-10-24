// подставной alloconnect-helper для автотестов: пишет команды в файл
const fs = require('fs');
const mode = process.argv[2];
const log = (process.env.FAKE_LOG || '/tmp/fake') + '-' + mode + '.log';
fs.appendFileSync(log, `START ${process.argv.slice(2).join(' ')}\n`);
if (mode === 'input') process.stdout.write('OK\n'); else process.stderr.write('OK\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    fs.appendFileSync(log, l + '\n');
    if (mode === 'input' && l.startsWith('pad ')) { if (!global.padSaid) { global.padSaid = 1; process.stdout.write('pad ok\nrumble 200 100\n'); } }
  }
});
process.stdin.on('end', () => { fs.appendFileSync(log, 'EOF\n'); process.exit(0); });
