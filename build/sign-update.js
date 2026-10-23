#!/usr/bin/env node
'use strict';
/* Подпись обновления alloconnect.
   Запуск:  node build/sign-update.js <папка resources собранной программы> <путь к секретному ключу .pem>
   Пример:  node build/sign-update.js dist/win-unpacked/resources alloconnect-update-private.pem

   Берёт app.asar и alloconnect-helper.exe из папки resources, считает их размеры и SHA-256,
   собирает описание (manifest), подписывает секретным ключом и кладёт рядом update.json.
   Именно update.json программа раздаёт другу, а его alloconnect проверяет подпись этим же
   ключом (открытая половина зашита в программе). Секретный ключ держи только у себя. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPDATE_FILES = ['app.asar', 'alloconnect-helper.exe'];

function main() {
  const [resDir, keyPath] = process.argv.slice(2);
  if (!resDir || !keyPath) {
    console.error('Использование: node build/sign-update.js <папка resources> <секретный ключ .pem>');
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  // версия Electron из собранной программы (если рядом есть), иначе из package-lock
  let electron = pkg.devDependencies.electron.replace(/[^\d.]/g, '');
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf-8'));
    electron = (lock.packages?.['node_modules/electron']?.version) || electron;
  } catch { /* */ }

  const files = UPDATE_FILES.map((n) => {
    const p = path.join(resDir, n);
    const buf = fs.readFileSync(p);
    return { n, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  });

  const notes = process.env.NOTES || '';
  const manifest = { app: 'alloconnect', v: pkg.version, electron, files, notes };
  const m = JSON.stringify(manifest);

  const priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (priv.asymmetricKeyType !== 'ed25519') { console.error('Это не ключ Ed25519'); process.exit(2); }
  const sig = crypto.sign(null, Buffer.from(m, 'utf-8'), priv).toString('base64');

  // контрольная самопроверка подписи открытым ключом из ключа-пары
  const pub = crypto.createPublicKey(priv);
  if (!crypto.verify(null, Buffer.from(m, 'utf-8'), pub, Buffer.from(sig, 'base64'))) {
    console.error('Подпись не прошла самопроверку — что-то не так с ключом');
    process.exit(1);
  }

  fs.writeFileSync(path.join(resDir, 'update.json'), JSON.stringify({ m, sig }));
  console.log('update.json записан в', resDir);
  console.log('версия', manifest.v, '· electron', electron);
  for (const f of files) console.log('  ', f.n, (f.size / 1048576).toFixed(2) + ' МБ', f.sha256.slice(0, 16) + '…');
  console.log('\nОткрытый ключ этой пары (должен совпадать с зашитым в программе):');
  console.log(pub.export({ type: 'spki', format: 'pem' }).trim());
}

main();
