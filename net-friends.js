'use strict';
/* =========================================================
   Друзья без серверов.
   - ID = публичный ключ X25519. Секретный ключ не покидает компьютер.
   - Пакеты шифруются AES-256-GCM ключом пары (ECDH). Расшифровать и подделать
     пакет может только друг, поэтому чужие пакеты молча выбрасываются.
   - Транспорт — UDP напрямую на запомненные адреса друга
     (UPnP-порт, Tailscale, локалка, последний адрес, с которого он писал).
   - «Пульс» раз в 20 с: статус «в сети» + держит дверь в роутере открытой.
   ========================================================= */
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const dns = require('dns');
const STUN_LISTS = require('./stun-lists.js');

const MAGIC = Buffer.from('ALC1');
const PING_EVERY = 15000;
const PUNCH_EVERY = 2000;      // в первые секунды после старта/новых адресов стучимся чаще
const PUNCH_FOR = 30000;
const STUN_MAGIC = 0x2112a442;
const ONLINE_WINDOW = 65000;
const OBSERVED_FRESH = 120000;
const TS_SKEW = 180000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function ipKind(ip) {
  const p = ip.split('.').map(Number);
  if (p[0] === 25 || p[0] === 26) return 'vpn'; // Hamachi / Radmin VPN
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'tailscale'; // 100.64/10 — CGNAT/Tailscale
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'lan';
  if (p[0] === 169 && p[1] === 254) return 'linklocal';
  if (p[0] === 127) return 'loopback';
  return 'public';
}

class FriendsNet extends EventEmitter {
  constructor({ dir, log, version }) {
    super();
    this.appVersion = version || '';
    this.activity = null; // { game } — во что сейчас играю (только для друзей)
    this.dir = dir;
    this.log = log || (() => {});
    this.friends = new Map();   // id -> friend
    this.keys = new Map();      // id -> aes key
    this.seenNonces = new Map();
    this.seenRids = new Map();
    this.pending = new Map();   // rid -> {resolve, reject, timer}
    this.parts = new Map();     // mid -> {n, got: [], ts}
    this.upnp = null;           // {ip, port}
    this.stun = null;           // {ip, port} — внешний адрес нашего UDP-порта
    this.natType = 'unknown';   // cone | symmetric | unknown
    this.stunWaiters = new Map();
    this.stunEnabled = true;
    // по порядку: основной список, затем альтернативный (только если основной молчит)
    this.stunPlan = [{ name: 'primary', urls: STUN_LISTS.primary }, { name: 'alt', urls: STUN_LISTS.alt }];
    this.stunUsed = null; // { list, first }
    this.punchUntil = 0;
    this.cnt = { sent: 0, recvOk: 0, recvBad: 0, recvUnknown: 0 };
    this.sock = null;
    this.port = 0;
  }

  /* ---------- хранение ---------- */
  file(name) { return path.join(this.dir, name); }
  readJson(name, def) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf-8')); } catch { return def; } }
  writeJson(name, data) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file(name + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
      fs.renameSync(tmp, this.file(name));
    } catch (e) { this.log('friends-error', 'write ' + name + ': ' + e.message); }
  }

  loadIdentity() {
    const saved = this.readJson('identity.json', null);
    if (saved?.priv) {
      this.priv = crypto.createPrivateKey(saved.priv);
    } else {
      this.priv = crypto.generateKeyPairSync('x25519').privateKey;
      this.writeJson('identity.json', { priv: this.priv.export({ type: 'pkcs8', format: 'pem' }), created: Date.now() });
    }
    this.id = crypto.createPublicKey(this.priv).export({ format: 'jwk' }).x;
    this.idBuf = Buffer.from(this.id, 'base64url');
  }

  loadFriends() {
    for (const f of this.readJson('friends.json', [])) {
      if (f?.id && f.id !== this.id) this.friends.set(f.id, { addrs: [], ...f, lastSeen: 0, online: false });
    }
  }
  saveFriends() {
    this.writeJson('friends.json', [...this.friends.values()].map((f) => ({
      id: f.id, nick: f.nick, addrs: f.addrs, hints: f.hints || [], observed: f.observed, added: f.added,
    })));
  }

  keyFor(id) {
    if (this.keys.has(id)) return this.keys.get(id);
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: id }, format: 'jwk' });
    const shared = crypto.diffieHellman({ privateKey: this.priv, publicKey: pub });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('alocalls friends v1'), 32));
    this.keys.set(id, key);
    return key;
  }

  // доказательство владения ключом в звонке по коду: посчитать его могут только двое — я и владелец id.
  // prover — чей это ответ (иначе чужой вызов можно отразить обратно), bind — DTLS-отпечатки этого звонка
  // (иначе ответ можно переслать из другого соединения)
  proof(id, prover, nonce, bind) {
    if (![id, prover, nonce, bind].every((s) => typeof s === 'string' && s.length > 0 && s.length < 600)) return null;
    if (id === this.id || (prover !== id && prover !== this.id)) return null;
    let key;
    try { key = this.keyFor(id); } catch { return null; }
    const k = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from('alloconnect ident proof v1'), 32));
    return crypto.createHmac('sha256', k).update([prover, nonce, bind].join('\n')).digest('base64url');
  }

  /* ---------- запуск ---------- */
  async start(preferredPort) {
    this.loadIdentity();
    this.loadFriends();
    const cfg = this.readJson('net.json', {});
    const tryPorts = [preferredPort, cfg.port, ...Array.from({ length: 5 }, () => 40000 + Math.floor(Math.random() * 20000))].filter(Boolean);
    for (const p of tryPorts) {
      try { await this.bind(p); break; } catch (e) { this.log('friends', `port ${p} busy: ${e.code || e.message}`); }
    }
    if (!this.sock) throw new Error('не удалось открыть UDP-порт');
    if (cfg.port !== this.port) this.writeJson('net.json', { ...cfg, port: this.port });
    this.timer = setInterval(() => this.pingAll(), PING_EVERY);
    this.punchTimer = setInterval(() => { if (Date.now() < this.punchUntil) this.pingAll(); }, PUNCH_EVERY);
    this.punch();
    this.statusTimer = setInterval(() => this.refreshOnline(), 5000);
    setTimeout(() => this.pingAll(), 500);
    this.cntTimer = setInterval(() => {
      if (this.friends.size) this.log('friends-net', { ...this.cnt, online: [...this.friends.values()].filter((f) => f.online).length });
      this.cnt = { sent: 0, recvOk: 0, recvBad: 0, recvUnknown: 0 };
    }, 60000);
    this.log('friends', { started: true, port: this.port, friends: this.friends.size });
    return { id: this.id, port: this.port };
  }

  bind(port) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      s.once('error', reject);
      s.bind(port, '0.0.0.0', () => {
        s.removeListener('error', reject);
        s.on('error', (e) => this.log('friends-error', 'socket: ' + e.message));
        s.on('message', (m, r) => this.onPacket(m, r));
        this.sock = s;
        this.port = s.address().port;
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.statusTimer);
    clearInterval(this.punchTimer);
    clearInterval(this.cntTimer);
    clearInterval(this.stunTimer);
    try { this.sock?.close(); } catch { /* */ }
    this.sock = null;
  }

  /* ---------- мои адреса ---------- */
  localAddrs() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal) continue;
        let kind = ipKind(a.address);
        if (kind === 'linklocal' || kind === 'loopback') continue;
        if (/radmin|hamachi|zerotier|wireguard|openvpn|tap-|tun|vpn|wintun|outline|amnezia/i.test(name) && !/tailscale/i.test(name)) kind = 'vpn';
        // «белый» адрес на сетевой карте считаем настоящим, только если с ним совпал STUN
        if (kind === 'public' && this.stun && this.stun.ip !== a.address) kind = 'vpn';
        if (kind === 'vpn') continue; // через чужой VPN друг не достучится — не предлагаем
        out.push({ kind, ip: a.address, port: this.port });
      }
    }
    if (this.upnp) out.push({ kind: 'upnp', ip: this.upnp.ip, port: this.upnp.port });
    if (this.stun && !out.some((a) => a.ip === this.stun.ip && a.port === this.stun.port)) {
      out.push({ kind: 'stun', ip: this.stun.ip, port: this.stun.port });
    }
    return out;
  }
  setUpnp(info) { this.upnp = info; }

  /* ---------- друзья ---------- */
  addFriend({ id, nick, addrs }) {
    if (!id || id === this.id) return false;
    try { this.keyFor(id); } catch { return false; } // проверка, что это валидный ключ
    const old = this.friends.get(id);
    this.friends.set(id, {
      ...(old || {}), id, nick: String(nick || old?.nick || 'Друг').slice(0, 24),
      addrs: this.cleanAddrs(addrs || old?.addrs || []), added: old?.added || Date.now(),
      lastSeen: old?.lastSeen || 0, online: old?.online || false,
    });
    this.saveFriends();
    this.emitList();
    setTimeout(() => this.ping(id), 200);
    this.punch();
    this.log('friends', { added: id.slice(0, 8), addrKinds: (addrs || []).map((a) => a.kind) });
    return true;
  }
  /* адрес друга по работающему пути WebRTC (из звонка) — надёжнее STUN, если у кого-то VPN */
  addCallHint(id, ip) {
    const f = this.friends.get(id);
    if (!f || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ipKind(ip) === 'lan' || ipKind(ip) === 'loopback') return null;
    const base = f.addrs.find((a) => a.kind === 'stun') || f.addrs.find((a) => a.kind === 'upnp') || f.addrs[0];
    if (!base) return null;
    const ports = [...new Set([base.port, ...f.addrs.map((a) => a.port)])].slice(0, 3);
    f.hints = ports.map((port) => ({ kind: 'call', ip, port }));
    this.saveFriends();
    this.punch();
    this.ping(id);
    const stunAddr = f.addrs.find((a) => a.kind === 'stun');
    return { friendStunMatchesCall: stunAddr ? stunAddr.ip === ip : null };
  }

  removeFriend(id) {
    this.friends.delete(id);
    this.keys.delete(id);
    this.saveFriends();
    this.emitList();
  }
  renameFriend(id, nick) {
    const f = this.friends.get(id);
    if (!f) return;
    f.nick = String(nick).slice(0, 24);
    this.saveFriends();
    this.emitList();
  }
  cleanAddrs(addrs) {
    return (Array.isArray(addrs) ? addrs : [])
      .filter((a) => a && /^\d+\.\d+\.\d+\.\d+$/.test(a.ip) && a.port > 0 && a.port < 65536)
      .slice(0, 8)
      .map((a) => ({ kind: String(a.kind || 'lan').slice(0, 12), ip: a.ip, port: a.port }));
  }
  list() {
    return [...this.friends.values()].map((f) => ({
      id: f.id, nick: f.nick, online: f.online, lastSeen: f.lastSeen,
      via: f.via || null, addrKinds: f.addrs.map((a) => a.kind),
      ver: f.ver || null, act: f.online ? (f.act || null) : null,
    }));
  }
  setActivity(a) {
    this.activity = a && typeof a.game === 'string' ? { game: a.game.slice(0, 48) } : null;
    this.pingAll(); // друзья увидят сразу, а не через 15 с
  }
  emitList() { this.emit('friends', this.list()); }
  refreshOnline() {
    let changed = false;
    for (const f of this.friends.values()) {
      const on = Date.now() - f.lastSeen < ONLINE_WINDOW;
      if (on !== f.online) { f.online = on; changed = true; this.log('friends', { presence: f.id.slice(0, 8), online: on }); }
    }
    if (changed) this.emitList();
  }

  targets(f) {
    const seen = new Set();
    const out = [];
    const push = (a, kind) => {
      const k = `${a.ip}:${a.port}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ ...a, kind: kind || a.kind });
    };
    if (f.observed && Date.now() - f.observed.ts < OBSERVED_FRESH) push(f.observed, 'observed');
    for (const a of f.hints || []) push(a);
    for (const a of f.addrs) push(a);
    if (f.observed) push(f.observed, 'observed-old');
    return out;
  }

  /* ---------- шифрование ---------- */
  seal(id, obj) {
    const key = this.keyFor(id);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(this.idBuf);
    const body = Buffer.concat([c.update(Buffer.from(JSON.stringify({ ...obj, ts: Date.now() }))), c.final()]);
    return Buffer.concat([MAGIC, this.idBuf, nonce, body, c.getAuthTag()]);
  }

  open(buf) {
    if (buf.length < 4 + 32 + 12 + 16 + 2 || !buf.subarray(0, 4).equals(MAGIC)) return null;
    const from = buf.subarray(4, 36);
    const id = from.toString('base64url');
    if (!this.friends.has(id)) { this.cnt.recvUnknown++; return null; } // не друг — выбрасываем без ответа
    const nonce = buf.subarray(36, 48);
    const nk = id + nonce.toString('hex');
    if (this.seenNonces.has(nk)) return null;         // повтор пакета
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.keyFor(id), nonce);
      d.setAAD(from);
      d.setAuthTag(buf.subarray(buf.length - 16));
      const plain = Buffer.concat([d.update(buf.subarray(48, buf.length - 16)), d.final()]);
      const msg = JSON.parse(plain.toString());
      if (Math.abs(Date.now() - msg.ts) > TS_SKEW) { this.cnt.recvBad++; this.log('friends-error', 'clock skew ' + Math.round((Date.now() - msg.ts) / 1000) + 's'); return null; }
      this.seenNonces.set(nk, Date.now());
      if (this.seenNonces.size > 5000) this.gc();
      this.cnt.recvOk++;
      return { id, msg };
    } catch { this.cnt.recvBad++; return null; }
  }

  gc() {
    const lim = Date.now() - TS_SKEW * 2;
    for (const [k, t] of this.seenNonces) if (t < lim) this.seenNonces.delete(k);
    for (const [k, t] of this.seenRids) if (t < lim) this.seenRids.delete(k);
  }

  sendTo(id, obj, addr) {
    if (!this.sock) return;
    const pkt = this.seal(id, obj);
    this.cnt.sent++;
    this.sock.send(pkt, addr.port, addr.ip, (e) => { if (e && e.code !== 'ENETUNREACH' && e.code !== 'EHOSTUNREACH') this.log('friends-error', `send ${addr.kind}: ${e.code || e.message}`); });
  }

  sendAll(id, obj) {
    const f = this.friends.get(id);
    if (!f) return 0;
    const t = this.targets(f);
    for (const a of t) this.sendTo(id, obj, a);
    return t.length;
  }

  /* надёжная доставка: повторяем, пока не придёт подтверждение */
  sendReliable(id, obj, { tries = 30, every = 700 } = {}) {
    return new Promise((resolve, reject) => {
      const rid = crypto.randomBytes(6).toString('hex');
      let n = 0;
      const attempt = () => {
        if (n++ >= tries) { this.pending.delete(rid); reject(new Error('друг не ответил')); return; }
        const sent = this.sendAll(id, { ...obj, rid });
        if (!sent) { this.pending.delete(rid); reject(new Error('нет адресов друга')); return; }
        p.timer = setTimeout(attempt, every);
      };
      const p = { resolve, reject, timer: null };
      this.pending.set(rid, p);
      attempt();
    });
  }

  /* крупное сообщение (записка звонка ~1.5 КБ) — частями, чтобы не упираться в MTU */
  async sendBig(id, obj) {
    const text = JSON.stringify(obj);
    if (text.length <= 900) return this.sendReliable(id, obj);
    const mid = crypto.randomBytes(5).toString('hex');
    const parts = [];
    for (let i = 0; i < text.length; i += 900) parts.push(text.slice(i, i + 900));
    await Promise.all(parts.map((d, i) => this.sendReliable(id, { t: 'part', mid, i, n: parts.length, d })));
  }

  /* ---------- пульс ---------- */
  ping(id) { this.sendAll(id, { t: 'ping', addrs: this.localAddrs(), ver: this.appVersion, act: this.activity }); }
  pingAll() { for (const id of this.friends.keys()) this.ping(id); }

  /* проверка «может ли друг достучаться»: шлём на каждый его адрес отдельно */
  probe(id) {
    const f = this.friends.get(id);
    if (!f) return;
    for (const a of f.addrs) this.sendTo(id, { t: 'probe', kind: a.kind }, a);
  }

  punch() { this.punchUntil = Date.now() + PUNCH_FOR; }

  /* ---------- STUN со своего порта: узнаём внешний адрес и тип NAT ---------- */
  stunRequest(host, port, timeout = 2500) {
    return new Promise((resolve) => {
      dns.lookup(host, { family: 4 }, (err, ip) => {
        if (err || !this.sock) return resolve(null);
        const tx = crypto.randomBytes(12);
        const req = Buffer.alloc(20);
        req.writeUInt16BE(0x0001, 0);
        req.writeUInt16BE(0, 2);
        req.writeUInt32BE(STUN_MAGIC, 4);
        tx.copy(req, 8);
        const key = tx.toString('hex');
        const t = setTimeout(() => { this.stunWaiters.delete(key); resolve(null); }, timeout);
        this.stunWaiters.set(key, (addr) => { clearTimeout(t); resolve(addr); });
        let n = 0;
        const send = () => { if (this.stunWaiters.has(key) && n++ < 3) { this.sock?.send(req, port, ip); setTimeout(send, 700); } };
        send();
      });
    });
  }

  onStun(buf) {
    if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101 || buf.readUInt32BE(4) !== STUN_MAGIC) return false;
    const key = buf.subarray(8, 20).toString('hex');
    const done = this.stunWaiters.get(key);
    if (!done) return true;
    this.stunWaiters.delete(key);
    let off = 20;
    let addr = null;
    while (off + 4 <= buf.length) {
      const type = buf.readUInt16BE(off);
      const len = buf.readUInt16BE(off + 2);
      const v = buf.subarray(off + 4, off + 4 + len);
      if ((type === 0x0020 || type === 0x8020) && v[1] === 1) {
        const port = v.readUInt16BE(2) ^ (STUN_MAGIC >>> 16);
        const ipn = v.readUInt32BE(4) ^ STUN_MAGIC;
        addr = { ip: [ipn >>> 24, (ipn >>> 16) & 255, (ipn >>> 8) & 255, ipn & 255].join('.'), port };
        break;
      }
      if (type === 0x0001 && v[1] === 1 && !addr) addr = { ip: [...v.subarray(4, 8)].join('.'), port: v.readUInt16BE(2) };
      off += 4 + len + ((4 - (len % 4)) % 4);
    }
    done(addr);
    return true;
  }

  // настройки STUN из окна: выключен / сразу альтернативные / свои
  setStunConfig(cfg = {}) {
    this.stunEnabled = !cfg.noStun;
    if (cfg.noStun) this.stunUsed = null;
    const custom = Array.isArray(cfg.stunCustom) ? cfg.stunCustom.filter((u) => STUN_LISTS.hostPort(u)) : [];
    if (custom.length) this.stunPlan = [{ name: 'custom', urls: custom }];
    else if (cfg.stunAlt) this.stunPlan = [{ name: 'alt', urls: STUN_LISTS.alt }];
    else this.stunPlan = [{ name: 'primary', urls: STUN_LISTS.primary }, { name: 'alt', urls: STUN_LISTS.alt }];
  }

  // опрашиваем все серверы списка разом; первый ответивший — в лог
  async stunList(urls) {
    const t0 = Date.now();
    let first = null;
    const res = await Promise.all(urls.map(async (u) => {
      const hp = STUN_LISTS.hostPort(u);
      if (!hp) return null;
      const r = await this.stunRequest(hp[0], hp[1]);
      if (r && !first) first = { host: hp[0] + ':' + hp[1], ms: Date.now() - t0 };
      return r;
    }));
    return { results: res.filter(Boolean), first };
  }

  async runStun() {
    if (!this.stunEnabled || !this.sock) return null;
    // ALOCALLS_STUN_TEST=host:port,host:port — только для автотестов
    const plan = process.env.ALOCALLS_STUN_TEST
      ? [{ name: 'test', urls: process.env.ALOCALLS_STUN_TEST.split(',').map((x) => 'stun:' + x) }]
      : this.stunPlan;
    let results = [];
    for (let i = 0; i < plan.length; i++) {
      const { results: got, first } = await this.stunList(plan[i].urls);
      this.log('net-check', { stunFromFriendsPort: plan[i].name, answered: got.length, of: plan[i].urls.length, firstReply: first?.host || null, ms: first?.ms ?? null });
      if (got.length) { results = got; this.stunUsed = { list: plan[i].name, first: first?.host || null }; break; }
      if (i < plan.length - 1) this.log('net-check', { stunFromFriendsPort: 'switching', to: plan[i + 1].name });
    }
    const prev = this.stun;
    if (!results.length) {
      this.stunUsed = { list: plan[plan.length - 1].name, first: null };
      this.log('net-check', { stunFromFriendsPort: 'no-answer' });
      return null;
    }
    this.stun = results[0];
    // разные внешние порты для разных серверов → «строгий» (симметричный) NAT, пробивка почти не сработает
    this.natType = results.length < 2 ? 'unknown' : (results.every((r) => r.port === results[0].port && r.ip === results[0].ip) ? 'cone' : 'symmetric');
    this.log('net-check', { stunFromFriendsPort: 'ok', list: this.stunUsed.list, natType: this.natType, portPreserved: this.stun.port === this.port, servers: results.length });
    if (!prev || prev.ip !== this.stun.ip || prev.port !== this.stun.port) { this.punch(); this.pingAll(); }
    return this.stun;
  }

  startStun() {
    const report = () => this.emit('stun', { stun: !!this.stun, natType: this.natType, portPreserved: this.stun ? this.stun.port === this.port : null, used: this.stunUsed });
    this.runStun().then(report);
    clearInterval(this.stunTimer);
    this.stunTimer = setInterval(() => this.runStun().then(report), 5 * 60 * 1000);
  }

  onPacket(buf, rinfo) {
    if (buf.length >= 20 && buf[0] === 0x01 && buf[1] === 0x01 && this.onStun(buf)) return;
    const r = this.open(buf);
    if (!r) return;
    const { id, msg } = r;
    const f = this.friends.get(id);
    const src = { ip: rinfo.address, port: rinfo.port, ts: Date.now() };
    const prevOnline = f.online;
    f.lastSeen = Date.now();
    f.online = true;
    const obsChanged = !f.observed || f.observed.ip !== src.ip || f.observed.port !== src.port;
    f.observed = src;
    f.via = ipKind(src.ip);
    if (Array.isArray(msg.addrs)) {
      const clean = this.cleanAddrs(msg.addrs);
      if (JSON.stringify(clean) !== JSON.stringify(f.addrs)) { f.addrs = clean; this.saveFriends(); this.punch(); }
    }
    if (obsChanged) this.saveFriends();
    // версия программы и «играет в …» приходят в пингах
    if (msg.t === 'ping' || msg.t === 'pong') {
      const ver = /^\d+\.\d+\.\d+$/.test(String(msg.ver || '')) ? String(msg.ver) : null;
      const act = msg.act && typeof msg.act.game === 'string' ? { game: String(msg.act.game).slice(0, 48) } : null;
      if (ver !== (f.ver || null) || JSON.stringify(act) !== JSON.stringify(f.act || null)) { f.ver = ver; f.act = act; if (prevOnline) this.emitList(); }
    }
    if (!prevOnline) { this.log('friends', { presence: id.slice(0, 8), online: true, via: f.via }); this.emitList(); }

    const reply = (o) => this.sendTo(id, o, { ...src, kind: 'reply' });
    switch (msg.t) {
      case 'ping': reply({ t: 'pong', addrs: this.localAddrs(), ver: this.appVersion, act: this.activity }); return;
      case 'pong': return;
      case 'probe':
        this.log('net-check', { inboundFromFriend: id.slice(0, 8), viaMyAddr: msg.kind, srcKind: ipKind(src.ip) });
        this.emit('probe-in', id, msg.kind);
        reply({ t: 'probe-ok', kind: msg.kind });
        return;
      case 'probe-ok':
        this.log('net-check', { friendReachableVia: msg.kind, friend: id.slice(0, 8) });
        this.emit('probe-ok', id, msg.kind);
        return;
      case 'ack': {
        const p = this.pending.get(msg.rid);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.rid); p.resolve(); }
        return;
      }
      default:
        if (msg.rid) {
          reply({ t: 'ack', rid: msg.rid });
          if (this.seenRids.has(msg.rid)) return; // дубликат повторной отправки
          this.seenRids.set(msg.rid, Date.now());
        }
        if (msg.t === 'part') {
          const key = id + msg.mid;
          const e = this.parts.get(key) || { n: msg.n, got: new Array(msg.n), ts: Date.now() };
          if (msg.i >= 0 && msg.i < e.n) e.got[msg.i] = String(msg.d);
          this.parts.set(key, e);
          for (const [k, v] of this.parts) if (Date.now() - v.ts > 60000) this.parts.delete(k);
          if (e.got.filter((x) => x != null).length === e.n) {
            this.parts.delete(key);
            try { this.emit('message', id, JSON.parse(e.got.join(''))); } catch (er) { this.log('friends-error', 'reassemble: ' + er.message); }
          }
          return;
        }
        this.emit('message', id, msg);
    }
  }
}

module.exports = { FriendsNet, ipKind };
