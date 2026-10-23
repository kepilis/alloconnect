'use strict';
/* =========================================================
   Минимальный UPnP IGD-клиент: найти роутер, узнать внешний IP,
   открыть/закрыть UDP-порт. Без зависимостей.
   ========================================================= */
const dgram = require('dgram');
const http = require('http');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function discover(timeout = 3000) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { s.close(); } catch { /* */ }
      resolve([...found.values()]);
    };
    s.on('error', finish);
    s.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const loc = /^location:\s*(.+)$/im.exec(text);
      if (loc) {
        const url = loc[1].trim();
        if (!found.has(url)) found.set(url, { location: url, router: rinfo.address });
      }
    });
    s.bind(0, () => {
      for (const st of TARGETS) {
        const req = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\nMX: 2\r\n' +
          `ST: ${st}\r\n\r\n`,
        );
        // ALOCALLS_SSDP_TEST=host:port — только для автотестов (поддельный роутер)
        const t = process.env.ALOCALLS_SSDP_TEST;
        if (t) { const [h, p] = t.split(':'); s.send(req, Number(p), h, () => {}); } else s.send(req, SSDP_PORT, SSDP_ADDR, () => {});
      }
    });
    setTimeout(finish, timeout);
  });
}

function httpReq(url, { method = 'GET', headers = {}, body = null, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function findService(dev) {
  const r = await httpReq(dev.location);
  const xml = r.body;
  const base = (/<URLBase>\s*([^<]+)\s*<\/URLBase>/i.exec(xml) || [])[1] || dev.location;
  for (const type of SERVICES) {
    const re = new RegExp(`<service>(?:(?!</service>)[\\s\\S])*?<serviceType>\\s*${type.replace(/[.:]/g, (c) => '\\' + c)}\\s*</serviceType>(?:(?!</service>)[\\s\\S])*?</service>`, 'i');
    const block = re.exec(xml);
    if (!block) continue;
    const ctrl = (/<controlURL>\s*([^<]+)\s*<\/controlURL>/i.exec(block[0]) || [])[1];
    if (ctrl) return { type, control: new URL(ctrl, base).toString(), router: dev.router };
  }
  return null;
}

async function soap(svc, action, args = {}) {
  const argXml = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${svc.type}">${argXml}</u:${action}></s:Body></s:Envelope>`;
  const r = await httpReq(svc.control, {
    method: 'POST', body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"` },
  });
  if (r.status !== 200) {
    const code = (/<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(r.body) || [])[1];
    const desc = (/<errorDescription>\s*([^<]+)\s*<\/errorDescription>/i.exec(r.body) || [])[1];
    const e = new Error(`UPnP ${action}: ${code || r.status} ${desc || ''}`.trim());
    e.upnpCode = Number(code) || r.status;
    throw e;
  }
  return r.body;
}

function localIpFor(router) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.connect(1900, router, (err) => {
      let ip = null;
      try { if (!err) ip = s.address().address; } catch { /* */ }
      try { s.close(); } catch { /* */ }
      resolve(ip);
    });
  });
}

class Upnp {
  constructor(log) { this.log = log || (() => {}); this.svc = null; this.mapped = null; }

  async init() {
    const devs = await discover();
    if (!devs.length) return { found: false };
    for (const d of devs) {
      try {
        const svc = await findService(d);
        if (svc) { this.svc = svc; break; }
      } catch (e) { this.log('upnp', 'desc failed: ' + e.message); }
    }
    if (!this.svc) return { found: true, service: false };
    return { found: true, service: true, type: this.svc.type.split(':').slice(-2).join(':') };
  }

  async externalIp() {
    const xml = await soap(this.svc, 'GetExternalIPAddress');
    return (/<NewExternalIPAddress>\s*([^<]*)\s*<\/NewExternalIPAddress>/i.exec(xml) || [])[1] || null;
  }

  async map(internalPort, lease = 3600) {
    const client = await localIpFor(this.svc.router);
    if (!client) throw new Error('не удалось определить локальный IP');
    const ports = [internalPort, ...Array.from({ length: 4 }, () => 40000 + Math.floor(Math.random() * 20000))];
    let lastErr;
    for (const ext of ports) {
      for (const leaseTry of [lease, 0]) { // часть роутеров принимает только бессрочные
        try {
          await soap(this.svc, 'AddPortMapping', {
            NewRemoteHost: '', NewExternalPort: ext, NewProtocol: 'UDP', NewInternalPort: internalPort,
            NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: 'alloconnect', NewLeaseDuration: leaseTry,
          });
          this.mapped = { ext, internalPort, lease: leaseTry };
          return this.mapped;
        } catch (e) {
          lastErr = e;
          if (e.upnpCode === 725 && leaseTry) continue; // OnlyPermanentLeasesSupported
          break;
        }
      }
    }
    throw lastErr || new Error('AddPortMapping failed');
  }

  async unmap() {
    if (!this.svc || !this.mapped) return;
    const ext = this.mapped.ext;
    this.mapped = null;
    try { await soap(this.svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: ext, NewProtocol: 'UDP' }); } catch { /* */ }
  }
}

module.exports = { Upnp };
