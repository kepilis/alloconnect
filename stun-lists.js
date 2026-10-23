/* Списки STUN-серверов alloconnect (общие для окна и для модуля друзей).
   STUN — одноразовый вопрос «какой у меня внешний адрес?». Звук и видео через него не идут.

   primary — основной короткий список: опрашивается всегда первым.
   alt     — запасной: 10 серверов разных компаний (не Google и не Cloudflare). Используется
             ВМЕСТО основного, только если основной за 2.5 с не дал ни одного внешнего адреса,
             или если в настройках включено «Сразу использовать альтернативные STUN».
   Живость alt проверена при разработке 21.10.2026 (по мониторингу always-online-stun,
   все были живы во всех проверках за неделю). В приложении никаких проверок нет. */
(function (root) {
  const STUN_LISTS = {
    primary: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
    alt: [
      'stun:stun.nextcloud.com:443',     // Nextcloud (порт 443 — проходит строгие фаерволы)
      'stun:stun.sipnet.ru:3478',        // Sipnet (Россия)
      'stun:stun.t-online.de:3478',      // Deutsche Telekom
      'stun:stun.1und1.de:3478',         // 1&1
      'stun:stun.telnyx.com:3478',       // Telnyx
      'stun:stun.linphone.org:3478',     // Linphone (Belledonne)
      'stun:stun.freeswitch.org:3478',   // FreeSWITCH
      'stun:stun.sonetel.com:3478',      // Sonetel
      'stun:stun.antisip.com:3478',      // Antisip
      'stun:stun.ipfire.org:3478',       // IPFire
    ],
  };

  // «stun:host:port», «host:port» или «host» → «stun:host:port»; мусор отбрасывается
  STUN_LISTS.parse = function parse(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\r\n,;]+/)) {
      const line = raw.trim().replace(/^stun:/i, '');
      if (!line) continue;
      const m = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i.exec(line);
      if (!m) continue;
      const port = m[5] ? Number(m[5]) : 3478;
      if (port < 1 || port > 65535) continue;
      const url = `stun:${m[1].toLowerCase()}:${port}`;
      if (!out.includes(url)) out.push(url);
      if (out.length >= 10) break;
    }
    return out;
  };

  // «stun:host:port» → ['host', port]
  STUN_LISTS.hostPort = function hostPort(url) {
    const m = /^stun:([^:]+):(\d+)$/.exec(url);
    return m ? [m[1], Number(m[2])] : null;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = STUN_LISTS;
  else root.STUN_LISTS = STUN_LISTS;
})(typeof window !== 'undefined' ? window : globalThis);
