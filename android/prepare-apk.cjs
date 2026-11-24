'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const baseVersion = '0.16.17';
const baseCode = 54;

function patchManifest(bytes, version, code) {
  assert.equal(bytes.readUInt16LE(0), 3);
  const pool = bytes.readUInt16LE(2);
  assert.equal(bytes.readUInt16LE(pool), 1);
  assert.equal(bytes.readUInt32LE(pool + 16) & 256, 0, 'Expected UTF-16 manifest strings');
  const count = bytes.readUInt32LE(pool + 8);
  const offsets = pool + bytes.readUInt16LE(pool + 2);
  const stringStart = pool + bytes.readUInt32LE(pool + 20);
  const strings = [];
  let versionReplaced = false;

  for (let i = 0; i < count; i++) {
    const offset = stringStart + bytes.readUInt32LE(offsets + 4 * i);
    const length = bytes.readUInt16LE(offset);
    assert.ok(length < 32768);
    const value = bytes.toString('utf16le', offset + 2, offset + 2 + 2 * length);
    strings.push(value);
    if (value !== baseVersion) continue;
    assert.equal(version.length, length, 'Manifest strings must stay the same size');
    bytes.write(version, offset + 2, 2 * length, 'utf16le');
    versionReplaced = true;
  }
  assert.ok(versionReplaced, 'Missing base version in Android manifest');

  for (let chunk = pool; chunk < bytes.length; chunk += bytes.readUInt32LE(chunk + 4)) {
    assert.ok(bytes.readUInt32LE(chunk + 4) >= 8);
    if (bytes.readUInt16LE(chunk) !== 0x102 || strings[bytes.readUInt32LE(chunk + 20)] !== 'manifest') continue;
    const first = chunk + 16 + bytes.readUInt16LE(chunk + 24);
    const stride = bytes.readUInt16LE(chunk + 26);
    for (let i = 0; i < bytes.readUInt16LE(chunk + 28); i++) {
      const attr = first + i * stride;
      if (strings[bytes.readUInt32LE(attr + 4)] !== 'versionCode') continue;
      assert.equal(bytes[attr + 15], 0x10);
      assert.equal(bytes.readUInt32LE(attr + 16), baseCode);
      bytes.writeUInt32LE(code, attr + 16);
      return;
    }
  }
  throw Error('Missing Android versionCode');
}

const [action, directory, version, codeArg, privateKeyPath, extra] = process.argv.slice(2);
const code = Number(codeArg);
assert.ok(directory && /^0\.16\.\d{2}$/.test(version) && version > baseVersion && Number.isInteger(code) && code > baseCode && privateKeyPath);
const key = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
assert.equal(key.asymmetricKeyType, 'ed25519');
const publicKey = crypto.createPublicKey(key);
const file = name => path.join(directory, name);
const web = path.join(__dirname, 'www');

if (action === 'prepare') {
  const manifest = fs.readFileSync(file('AndroidManifest.xml'));
  patchManifest(manifest, version, code);
  fs.writeFileSync(file('AndroidManifest.xml'), manifest);
  const updaterKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
  const base = fs.readFileSync(file('base-app.js'), 'utf8');
  for (const app of [base, source]) {
    assert.ok(app.includes(`const UPD_PUBKEY = '${updaterKey}';`), 'Update key does not match the Android updater');
    assert.ok(app.includes('commits/android-updates-next`'), 'Unexpected Android update channel');
  }
  const versionLine = /^const VERSION = '0\.16\.\d{2}';$/m;
  assert.ok(versionLine.test(source), 'Missing Android web version');
  fs.writeFileSync(file('app.js'), source.replace(versionLine, `const VERSION = '${version}';`));
} else if (action === 'describe') {
  assert.ok(extra?.trim(), 'Missing Android release notes');
  const name = `alloconnect_android-${version}-arm64-v8a.apk`;
  const apk = fs.readFileSync(file(name));
  const m = JSON.stringify({
    app: 'alloconnect-android', v: version, code,
    apk: { n: name, size: apk.length, sha256: crypto.createHash('sha256').update(apk).digest('hex') },
    notes: extra, abi: 'arm64-v8a',
  });
  const signature = crypto.sign(null, Buffer.from(m), key);
  assert.ok(crypto.verify(null, Buffer.from(m), publicKey, signature));
  fs.writeFileSync(file('update-android.json'), JSON.stringify({ m, sig: signature.toString('base64') }) + '\n');
} else if (action === 'archive') {
  const replacements = new Map([
    ['AndroidManifest.xml', file('AndroidManifest.xml')],
    ['assets/public/app.js', file('app.js')],
  ]);
  for (const name of fs.readdirSync(web).filter(name => name !== 'app.js' && /\.(js|html|css)$/.test(name))) {
    replacements.set('assets/public/' + name, path.join(web, name));
  }
  writeAlignedArchive(fs.readFileSync(extra), file('aligned.apk'), replacements);
} else {
  throw Error('Expected prepare, archive or describe');
}

function writeAlignedArchive(base, output, replacements) {
  const end = base.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.equal(end + 22 + base.readUInt16LE(end + 20), base.length);
  const count = base.readUInt16LE(end + 10);
  let entry = base.readUInt32LE(end + 16);
  const localFiles = [];
  const directory = [];
  let position = 0;
  const matched = new Set();
  for (let i = 0; i < count; i++) {
    assert.equal(base.readUInt32LE(entry), 0x02014b50);
    const nameLength = base.readUInt16LE(entry + 28);
    const name = base.subarray(entry + 46, entry + 46 + nameLength);
    const entryName = name.toString('utf8');
    const central = Buffer.from(base.subarray(entry, entry + 46));
    entry += 46 + nameLength + central.readUInt16LE(30) + central.readUInt16LE(32);
    if (/^META-INF\/([^/]+\.(RSA|DSA|EC|SF)|MANIFEST\.MF)$/i.test(entryName)) continue;

    const local = central.readUInt32LE(42);
    assert.equal(base.readUInt32LE(local), 0x04034b50);
    assert.equal(base.readUInt16LE(local + 26), nameLength);
    const dataOffset = local + 30 + nameLength + base.readUInt16LE(local + 28);
    const method = central.readUInt16LE(10);
    assert.ok(method === 0 || method === 8);
    const flags = central.readUInt16LE(8) & ~8;
    assert.equal(flags & 1, 0);
    let data = base.subarray(dataOffset, dataOffset + central.readUInt32LE(20));
    if (replacements.has(entryName)) {
      matched.add(entryName);
      const raw = fs.readFileSync(replacements.get(entryName));
      data = method === 0 ? raw : zlib.deflateRawSync(raw);
      central.writeUInt32LE(zlib.crc32(raw), 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(raw.length, 24);
    }
    const header = Buffer.from(base.subarray(local, local + 30));
    const alignment = method !== 0 ? 1 : /^lib\/.*\.so$/.test(entryName) ? 16384 : 4;
    let padding = (alignment - (position + header.length + nameLength) % alignment) % alignment;
    if (padding > 0 && padding < 6) padding += alignment * Math.ceil((6 - padding) / alignment);
    const extra = Buffer.alloc(padding);
    if (padding) {
      extra.writeUInt16LE(0xd935);
      extra.writeUInt16LE(padding - 4, 2);
      extra.writeUInt16LE(alignment, 4);
    }
    header.writeUInt16LE(flags, 6);
    central.copy(header, 14, 16, 28);
    header.writeUInt16LE(padding, 28);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(position, 42);
    localFiles.push(header, name, extra, data);
    directory.push(central, name);
    position += header.length + nameLength + extra.length + data.length;
  }
  assert.equal(matched.size, replacements.size, 'APK is missing entries to replace');
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(directory.length / 2, 8);
  footer.writeUInt16LE(directory.length / 2, 10);
  footer.writeUInt32LE(directory.reduce((size, part) => size + part.length, 0), 12);
  footer.writeUInt32LE(position, 16);
  fs.writeFileSync(output, Buffer.concat([...localFiles, ...directory, footer]));
}
