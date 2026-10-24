// поддельный STUN: отвечает «внешним» адресом 198.51.100.7, считает запросы по портам
const dgram = require('dgram');
const fs = require('fs');
const ports = (process.argv[2] || '3478').split(',').map(Number);
const counts = {};
for (const port of ports) {
  counts[port] = 0;
  const s = dgram.createSocket('udp4');
  s.on('message', (m, r) => {
    if (m.length < 20 || m.readUInt16BE(0) !== 0x0001) return;
    counts[port]++;
    fs.writeFileSync(process.argv[3] || 'counts.json', JSON.stringify(counts));
    const magic = 0x2112a442;
    const resp = Buffer.alloc(32);
    resp.writeUInt16BE(0x0101, 0); resp.writeUInt16BE(12, 2); resp.writeUInt32BE(magic, 4); m.copy(resp, 8, 8, 20);
    resp.writeUInt16BE(0x0020, 20); resp.writeUInt16BE(8, 22); resp.writeUInt8(0, 24); resp.writeUInt8(1, 25);
    resp.writeUInt16BE(r.port ^ (magic >>> 16), 26);
    const ip = [198, 51, 100, 7].reduce((a, b) => ((a << 8) | b) >>> 0, 0);
    resp.writeUInt32BE((ip ^ magic) >>> 0, 28);
    s.send(resp, r.port, r.address);
  });
  s.bind(port, '0.0.0.0');
}
fs.writeFileSync(process.argv[3] || 'counts.json', JSON.stringify(counts));
console.log('fake stun on', ports);
