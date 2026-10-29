// node tests/group/run-gcam.js [рабочая папка] — камера и окна в групповом звонке (h-gcam.js, три экземпляра).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareApp, runRoles, readRes } = require('../lib/roles');

const T = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-gcam-')));
const ROLES = ['A', 'B', 'C'];
const dirs = prepareApp(T, { files: { 'h-gcam.js': path.join(__dirname, 'h-gcam.js') }, main: 'h-gcam.js', roles: ROLES });

(async () => {
  await runRoles(dirs, ROLES, { killAfter: 480000 });
  for (const r of ROLES) {
    const flat = Object.entries(readRes(dirs.SH, r)).filter(([k]) => k !== 'errors' && k !== 'role');
    console.log(`== ${r}: ${flat.filter(([, v]) => v === true).length} true, ${flat.filter(([, v]) => v === false).length} false`);
    for (const [k, v] of flat) if (v !== true) console.log(`   ${k}: ${JSON.stringify(v).slice(0, 200)}`);
    const errs = readRes(dirs.SH, r).errors || [];
    if (errs.length) console.log('   ошибки: ' + errs.slice(0, 5).join(' | '));
  }
  console.log('папка:', T);
})();
