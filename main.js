const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, shell, clipboard,
  Tray, Menu, nativeImage, Notification, screen, dialog,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { FriendsNet, ipKind } = require('./net-friends.js');
const { Upnp } = require('./upnp.js');
// ALOCALLS_USERDATA — отдельная папка данных (для автотестов двух экземпляров на одной машине)
if (process.env.ALOCALLS_USERDATA) app.setPath('userData', process.env.ALOCALLS_USERDATA);

/* ---------- Переезд со старого имени (alocalls → alloconnect) ----------
   Друзья, свой ID, звуки, рингтон и настройки лежали в %APPDATA%\alocalls — копируем один раз. */
function migrateLegacy() {
  if (process.env.ALOCALLS_USERDATA) return null;
  try {
    const dst = app.getPath('userData');
    const src = path.join(app.getPath('appData'), 'alocalls');
    if (fs.existsSync(path.join(dst, 'identity.json')) || !fs.existsSync(path.join(src, 'identity.json'))) return null;
    const skip = new Set(['logs', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad',
      'blob_storage', 'Shared Dictionary', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);
    fs.mkdirSync(dst, { recursive: true });
    const copied = [];
    for (const n of fs.readdirSync(src)) {
      if (skip.has(n)) continue;
      try { fs.cpSync(path.join(src, n), path.join(dst, n), { recursive: true, force: true }); copied.push(n); } catch { /* занято — пропускаем */ }
    }
    return { copied: copied.length };
  } catch (e) { return { error: e.message }; }
}
const MIGRATED = migrateLegacy();

/* =========================================================
   ЛОГ (тестовая сборка): %APPDATA%\alloconnect\logs\alloconnect-ДАТА.log
   ========================================================= */
let logStream = null;
let logFile = '';
function logDir() { return path.join(app.getPath('userData'), 'logs'); }
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function openLog() {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    // храним последние 15 логов
    const old = fs.readdirSync(logDir()).filter((f) => f.endsWith('.log')).sort();
    while (old.length >= 15) { try { fs.unlinkSync(path.join(logDir(), old.shift())); } catch { /* */ } }
    logFile = path.join(logDir(), `alloconnect-${ts().replace(/[: ]/g, '-').replace(/\.\d+$/, '')}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (e) { console.error('log open', e); }
}
function log(tag, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const line = `${ts()} [${tag}] ${body}\n`;
  try { logStream?.write(line); } catch { /* */ }
}
process.on('uncaughtException', (e) => log('main-error', String(e && e.stack || e)));
process.on('unhandledRejection', (e) => log('main-error', 'unhandled: ' + String(e && e.stack || e)));

// Показывать реальные локальные адреса (в т.ч. Tailscale 100.x) вместо mDNS-имён,
// чтобы соединение работало в локалке/Tailscale даже без STUN.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// Флаги, которые читаются до старта Chromium (настройки из %APPDATA%\alloconnect\flags.json)
function readFlags() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'flags.json'), 'utf-8')); } catch { return {}; }
}
const FLAGS = readFlags();
// Захват экрана через Windows Graphics Capture (силами видеокарты) там, где Chromium сам его не выбирает
const enable = ['AllowWgcScreenCapturer', 'AllowWgcWindowCapturer'];
// AV1 через видеокарту в WebRTC (на Windows по умолчанию выключен) — экспериментально, по галочке
if (FLAGS.av1hw) enable.push('AV1HWEncode');
app.commandLine.appendSwitch('enable-features', enable.join(','));
// На ноутбуках — использовать дискретную видеокарту (кодирование видео)
app.commandLine.appendSwitch('force_high_performance_gpu');

app.setAppUserModelId('local.alloconnect');
// вторая копия — сразу выходим: app.quit() не мгновенный, и она успевала занять другой UDP-порт
// и записать его в net.json — после перезапуска друзья стучались на старый порт
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.exit(0);

let win = null;
// Источник для демонстрации, который пользователь выбрал в нашем окне выбора
let pendingSource = null; // { id, audio }

/* ---------- Трей, автозапуск, скрытие ---------- */
const APP_DEFAULTS = { tray: true, closeToTray: true, minToTray: false, autostart: false, startHidden: true, bossKey: true, notify: true, ownNotify: true };
let appSet = { ...APP_DEFAULTS, ...(FLAGS.app || {}) };
// 1.21: «сворачивать в трей» осталось включённым у тех, кто включил его в старых версиях (тогда это была одна
// неприметная галочка), и кнопка «свернуть» у них прятала окно в трей. Один раз возвращаем обычное сворачивание
let minReset = !!FLAGS.minReset;
if (!minReset) { appSet.minToTray = false; minReset = true; }
let tray = null;
let appQuitting = false;
let trayHintShown = !!FLAGS.trayHintShown;
let minHintShown = !!FLAGS.minHintShown;
let trayState = { inCall: false, friend: '', online: 0, muted: false };
const launchedHidden = process.argv.includes('--hidden');

function saveFlags() {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'flags.json'), JSON.stringify({ ...readFlags(), app: appSet, trayHintShown, minHintShown, minReset })); } catch (e) { log('main-error', 'flags: ' + e.message); }
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function hideToTray() {
  if (!win || !tray) return;
  win.hide();
  if (!trayHintShown) {
    trayHintShown = true;
    saveFlags();
    try { tray.displayBalloon({ title: 'alloconnect работает в трее', content: 'Друзья смогут тебе дозвониться. Выйти — правый клик по значку → «Выход».', iconType: 'info' }); } catch { /* */ }
  }
}
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16, quality: 'best' });
}
function updateTray() {
  if (!tray) return;
  const tip = trayState.inCall ? `alloconnect — в звонке с ${trayState.friend}` : `alloconnect — друзей в сети: ${trayState.online}`;
  tray.setToolTip(tip);
  const items = [
    { label: win && win.isVisible() ? 'Скрыть' : 'Открыть', click: () => (win && win.isVisible() ? win.hide() : showWindow()) },
    { type: 'separator' },
  ];
  if (trayState.inCall) {
    items.push({ label: trayState.muted ? 'Включить микрофон' : 'Выключить микрофон', click: () => win?.webContents.send('hotkey', 'mute') });
    items.push({ label: 'Завершить звонок', click: () => win?.webContents.send('hotkey', 'leave') });
    items.push({ type: 'separator' });
  }
  // как сворачивать — прямо здесь, а не только в настройках
  items.push({ label: 'Кнопка «свернуть» прячет в трей', type: 'checkbox', checked: !!appSet.minToTray,
    click: (mi) => { appSet = { ...appSet, minToTray: mi.checked }; saveFlags(); log('settings', { app: appSet }); updateTray(); } });
  items.push({ type: 'separator' });
  items.push({ label: 'Выход', click: () => { appQuitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
function applyTray() {
  if (appSet.tray && !tray) {
    try {
      tray = new Tray(trayIcon());
      tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
      tray.on('double-click', showWindow);
      updateTray();
    } catch (e) { log('main-error', 'tray: ' + e.message); tray = null; }
  } else if (!appSet.tray && tray) {
    tray.destroy();
    tray = null;
    if (win && !win.isVisible()) showWindow();
  }
}
let bossReg = false;
function applyBossKey() {
  if (bossReg) { try { globalShortcut.unregister('CommandOrControl+Shift+H'); } catch { /* */ } bossReg = false; }
  if (appSet.bossKey) {
    bossReg = globalShortcut.register('CommandOrControl+Shift+H', () => {
      if (!win) return;
      if (win.isVisible() && !win.isMinimized()) { if (tray) win.hide(); else win.minimize(); } else showWindow();
    });
  }
}
function applyAutostart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try { app.setLoginItemSettings({ openAtLogin: !!appSet.autostart, path: process.execPath, args: ['--hidden'] }); } catch (e) { log('main-error', 'autostart: ' + e.message); }
}
// Рация (push-to-talk): глобально ловим удержание Ctrl+Shift+V.
// globalShortcut даёт только нажатие, поэтому держим «открыто» и закрываем по таймеру,
// пока сочетание удерживается — Windows повторяет его авто-повтором (~раз в 33 мс).
let pttOn = false;
let pttReg = false;
let pttTimer = null;
function pttFire() {
  win?.webContents.send('hotkey', 'ptt-down');
  clearTimeout(pttTimer);
  pttTimer = setTimeout(() => win?.webContents.send('hotkey', 'ptt-up'), 300);
}
function applyPtt() {
  if (pttReg) { try { globalShortcut.unregister('CommandOrControl+Shift+V'); } catch { /* */ } pttReg = false; }
  clearTimeout(pttTimer);
  if (pttOn) { try { pttReg = globalShortcut.register('CommandOrControl+Shift+V', pttFire); } catch { /* */ } }
}
ipcMain.handle('set-ptt', (_e, on) => { pttOn = !!on; applyPtt(); log('settings', { ptt: pttOn }); });

ipcMain.handle('app-settings-get', () => appSet);
ipcMain.handle('app-settings-set', (_e, s) => {
  appSet = { ...appSet, ...s };
  saveFlags();
  applyTray();
  applyBossKey();
  if ('autostart' in s) applyAutostart();
  log('settings', { app: appSet });
  return appSet;
});
ipcMain.handle('tray-state', (_e, st) => { trayState = { ...trayState, ...st }; updateTray(); });
/* ---------- Свои уведомления (1.21): окно в углу в стиле темы — аватарка (гифки играют), ник, текст, картинка ----------
   Окно не забирает фокус и спрятано от захвата экрана (друг его в демонстрации не увидит).
   appSet.ownNotify === false — уведомления Windows, как раньше. */
let ntfWin = null, ntfReady = null, ntfSeq = 0;
const NTF_W = 380;
function ntfEnsure() {
  if (ntfWin && !ntfWin.isDestroyed()) return ntfWin;
  ntfWin = new BrowserWindow({
    width: NTF_W, height: 120, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', title: 'alloconnect-notify',
    webPreferences: { preload: path.join(__dirname, 'notify-preload.js'), contextIsolation: true, sandbox: true },
  });
  ntfWin.setAlwaysOnTop(true, 'screen-saver');
  try { ntfWin.setContentProtection(true); } catch { /* */ }
  ntfWin.webContents.on('will-navigate', (e) => e.preventDefault());
  ntfReady = new Promise((r) => ntfWin.webContents.once('did-finish-load', r));
  ntfWin.loadFile('notify.html');
  ntfWin.on('closed', () => { ntfWin = null; });
  return ntfWin;
}
ipcMain.on('ntf-size', (_e, h, n) => {
  if (!ntfWin || ntfWin.isDestroyed()) return;
  if (!n) { ntfWin.hide(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const H = Math.max(40, Math.min(Math.ceil(h), wa.height - 16));
  ntfWin.setBounds({ x: wa.x + wa.width - NTF_W - 8, y: wa.y + wa.height - H - 8, width: NTF_W, height: H });
  if (!ntfWin.isVisible()) ntfWin.showInactive();
});
ipcMain.on('ntf-click', (_e, d) => { showWindow(); win?.webContents.send('ntf-open', { peer: d?.peer || null, kind: d?.kind || '' }); });
ipcMain.handle('notify', async (_e, { title, body, kind, peer, media, theme }) => {
  if (!appSet.notify) return;
  if (win && win.isVisible() && win.isFocused()) return;
  if (appSet.ownNotify !== false) {
    try {
      const w = ntfEnsure();
      await ntfReady;
      const okId = typeof peer === 'string' && /^[A-Za-z0-9_-]{43}$/.test(peer);
      const a = okId ? avRead(peer) : null;
      const m = media?.bytes && media.bytes.length <= 8 * 1024 * 1024 && /^image\/(png|jpeg|gif|webp)$/.test(String(media.mime)) ? { bytes: Buffer.from(media.bytes), mime: media.mime } : null;
      w.webContents.send('ntf-show', {
        id: ++ntfSeq, title: String(title || '').slice(0, 80), body: String(body || '').slice(0, 200), kind: kind === 'call' ? 'call' : 'msg',
        peer: okId ? peer : null, key: okId ? peer + ':' + (kind || '') : null, theme: /^[a-z0-9]{0,20}$/.test(String(theme || '')) ? String(theme || '') : '',
        avatar: a?.bytes ? { bytes: a.bytes, mime: a.mime } : null, media: m,
      });
      return;
    } catch (e) { log('main-error', 'ntf: ' + e.message); }
  }
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({ title: String(title).slice(0, 80), body: String(body || '').slice(0, 200), icon: path.join(__dirname, 'icon.png'), silent: kind === 'msg' });
    n.on('click', showWindow);
    n.show();
  } catch (e) { log('main-error', 'notify: ' + e.message); }
});

function createWindow() {
  win = new BrowserWindow({
    show: !(launchedHidden && appSet.startHidden && appSet.tray),
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#111216',
    autoHideMenuBar: true,
    title: 'alloconnect',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // не душить звонок, когда окно свёрнуто
      autoplayPolicy: 'no-user-gesture-required', // звук и шумодав работают и без клика (входящий звонок)
    },
  });
  win.removeMenu(); // без стандартного меню File/Edit (всплывало по Alt)
  win.loadFile('index.html');
  // перетащенный в окно файл не должен открываться вместо приложения
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // окно звонка, вынесенное в отдельное окно Windows (windows.js): пустая страница, содержимое переносит окно программы
    if (/^alc-pop-(screen|cam|chat|gview|gchat)$/.test(frameName || '') && (!url || url === 'about:blank')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#111216', icon: path.join(__dirname, 'icon.png'), minWidth: 200, minHeight: 150 } };
    }
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { try { ntfWin?.destroy(); } catch { /* */ } });
  win.on('close', (e) => {
    if (!appQuitting && tray && appSet.closeToTray) { e.preventDefault(); hideToTray(); }
  });
  win.on('minimize', () => {
    if (!(tray && appSet.minToTray)) return;
    hideToTray(); // свернули → прячем и с панели задач
    // один раз подсказываем, где вернуть обычное сворачивание
    if (!minHintShown) {
      minHintShown = true;
      saveFlags();
      try { tray.displayBalloon({ title: 'alloconnect свёрнут в трей', content: 'Чтобы сворачивать на панель задач, сними галочку в меню этого значка или в Настройки → Программа.', iconType: 'info' }); } catch { /* */ }
    }
  });
  win.on('show', updateTray);
  win.on('hide', updateTray);
  win.webContents.on('render-process-gone', (_e, d) => log('crash', { what: 'renderer', ...d }));
  win.on('unresponsive', () => log('warn', 'window unresponsive'));
  win.on('responsive', () => log('warn', 'window responsive again'));
}
app.on('child-process-gone', (_e, d) => log('crash', d));

app.on('second-instance', () => showWindow());
app.on('before-quit', () => { appQuitting = true; });

app.whenReady().then(() => {
  if (!firstInstance) return;
  if (!FLAGS.minReset) saveFlags(); // запомнить, что обычное сворачивание уже вернули
  Menu.setApplicationMenu(null);
  openLog();
  logSystemInfo();
  if (MIGRATED) {
    log('start', { migratedFromAlocalls: MIGRATED });
    // старая запись автозапуска alocalls больше не нужна
    if (process.platform === 'win32') { try { app.setLoginItemSettings({ openAtLogin: false, name: 'local.alocalls' }); } catch { /* */ } }
  }
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock'].includes(permission));

  // getDisplayMedia() в окне → отдаём источник, выбранный в нашем пикере
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find((s) => s.id === pendingSource?.id) || sources.find((s) => s.id.startsWith('screen'));
      if (!src) return callback({});
      const resp = { video: src };
      // Системный звук умеет захватываться только на Windows
      if (pendingSource?.audio && process.platform === 'win32') resp.audio = 'loopback';
      callback(resp);
    } catch (e) {
      console.error(e);
      callback({});
    }
  });

  createWindow();
  applyTray();
  applyBossKey();
  if (appSet.autostart) applyAutostart();
  if (launchedHidden) log('start', { launchedHidden: true, startHidden: appSet.startHidden });
  startFriends();
  registerSoundHotkeys();
  boostPriority();
  setInterval(boostPriority, 10000);
  setInterval(logCpu, 1000);

  // Глобальные горячие клавиши (работают и в игре); сочетания меняются в настройках
  registerAppHotkeys();
  applyPtt();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

const sourceDisplay = new Map(); // id источника «экран» → id монитора
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  });
  for (const s of sources) if (s.display_id) sourceDisplay.set(s.id, String(s.display_id));
  return sources
    .filter((s) => s.name && s.name !== 'alloconnect' && s.name !== 'alloconnect-overlay')
    .map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen'),
      minimized: !s.id.startsWith('screen') && s.thumbnail.isEmpty(),
      thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      displayId: s.display_id || '',
    }));
});

ipcMain.handle('select-source', (_e, src) => {
  pendingSource = src;
  return true;
});

ipcMain.handle('attention', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

ipcMain.handle('platform', () => process.platform);
ipcMain.handle('clip-write', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('clip-read', () => clipboard.readText());

/* ---------- Приоритет процессов ----------
   Когда игра грузит процессор на 100%, Windows делит время поровну, и захват/кодирование
   экрана начинают голодать (1 fps). Поднимаем все процессы alloconnect на «выше среднего». */
function boostPriority() {
  if (process.platform !== 'win32') return;
  for (const m of app.getAppMetrics()) {
    try { os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (e) { log('warn', `priority ${m.type} ${m.pid}: ${e.message}`); }
  }
}

/* ---------- Системный звук без голосов из alloconnect ----------
   alloconnect-helper.exe захватывает звук через Windows Process Loopback:
   - экран: весь звук, кроме самого alloconnect (голос друга не попадёт обратно к нему);
   - окно: только звук этого приложения. */
let audioProc = null;

function helperPath() {
  const packaged = path.join(process.resourcesPath || '', 'alloconnect-helper.exe');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, 'native', 'alloconnect-helper.exe');
}

// ALOCALLS_FAKE_HELPER=путь.js — только для автотестов: подставной помощник вместо exe
const FAKE_HELPER = process.env.ALOCALLS_FAKE_HELPER || '';
function spawnHelper(args, opts) {
  if (FAKE_HELPER) return spawn(process.execPath, [FAKE_HELPER, ...args], { ...opts, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  return spawn(helperPath(), args, opts);
}
const helperUsable = () => !!FAKE_HELPER || (process.platform === 'win32' && fs.existsSync(helperPath()));

function stopSysAudio() {
  if (!audioProc) return;
  const p = audioProc;
  audioProc = null;
  try { p.kill(); } catch { /* ignore */ }
}

ipcMain.handle('sysaudio-start', (_e, { sourceId }) => new Promise((resolve) => {
  stopSysAudio();
  if (process.platform !== 'win32') return resolve({ ok: false, error: 'только Windows' });
  const exe = helperPath();
  if (!fs.existsSync(exe)) return resolve({ ok: false, error: 'нет alloconnect-helper.exe' });

  let args;
  const m = /^window:(\d+):/.exec(sourceId || '');
  if (m) args = ['window', m[1]];
  else args = ['exclude', String(process.pid)];

  log('sysaudio', { start: args, exe });
  let proc;
  try {
    proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return resolve({ ok: false, error: e.message });
  }
  audioProc = proc;
  let settled = false;
  const settle = (r) => { if (!settled) { settled = true; log('sysaudio', { result: r }); resolve(r); } };
  let bytes = 0;
  const rate = setInterval(() => { if (audioProc === proc) log('sysaudio', { bytesPerSec: bytes }); bytes = 0; }, 5000);
  const timer = setTimeout(() => settle({ ok: false, error: 'помощник не ответил' }), 4000);
  let errBuf = '';

  proc.stderr.on('data', (d) => {
    errBuf += d.toString();
    log('sysaudio', 'stderr: ' + d.toString().trim());
    if (/^OK/m.test(errBuf)) { clearTimeout(timer); settle({ ok: true, mode: args[0] }); }
    const em = /^ERR (.*)$/m.exec(errBuf);
    if (em) { clearTimeout(timer); settle({ ok: false, error: em[1] }); }
  });
  proc.stdout.on('data', (chunk) => {
    bytes += chunk.length / 5; // за 5 секунд → в секунду
    if (audioProc === proc && win && !win.isDestroyed()) win.webContents.send('sysaudio-data', chunk);
  });
  proc.on('error', (e) => { clearTimeout(timer); settle({ ok: false, error: e.message }); });
  proc.on('exit', (code) => {
    clearTimeout(timer);
    clearInterval(rate);
    log('sysaudio', { exit: code });
    settle({ ok: false, error: 'помощник завершился, код ' + code });
    if (audioProc === proc) {
      audioProc = null;
      win?.webContents.send('sysaudio-end', code);
    }
  });
}));

ipcMain.handle('sysaudio-stop', () => { stopSysAudio(); return true; });

/* ---------- Слежение за окном, которое стримим (свёрнуто / развёрнуто / закрыто) ---------- */
let watchProc = null;
function hwndOf(sourceId) { const m = /^window:(\d+):/.exec(sourceId || ''); return m ? m[1] : null; }
ipcMain.handle('win-watch-start', (_e, sourceId) => new Promise((resolve) => {
  try { watchProc?.kill(); } catch { /* */ }
  watchProc = null;
  lastWatchRect = null;
  lastWatchState = 'normal';
  const hwnd = hwndOf(sourceId);
  const exe = helperPath();
  if (process.platform !== 'win32' || !hwnd || !fs.existsSync(exe)) return resolve('unknown');
  let first = true;
  const p = spawn(exe, ['watch', hwnd], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  watchProc = p;
  const t = setTimeout(() => { if (first) { first = false; resolve('unknown'); } }, 2000);
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const st = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!st) continue;
      if (st.startsWith('rect ')) { onWatchRect(st.slice(5).split(' ').map(Number)); continue; }
      log('share', { windowState: st });
      onWatchState(st);
      if (first) { first = false; clearTimeout(t); resolve(st); } else sendWin('win-state', st);
    }
  });
  p.on('error', () => { if (first) { first = false; clearTimeout(t); resolve('unknown'); } });
  p.on('exit', () => { if (watchProc === p) watchProc = null; });
}));
ipcMain.handle('win-watch-stop', () => { try { watchProc?.kill(); } catch { /* */ } watchProc = null; });
ipcMain.handle('win-restore', (_e, sourceId) => new Promise((resolve) => {
  const hwnd = hwndOf(sourceId);
  const exe = helperPath();
  if (process.platform !== 'win32' || !hwnd || !fs.existsSync(exe)) return resolve(false);
  const p = spawn(exe, ['restore', hwnd], { windowsHide: true });
  p.on('exit', (code) => resolve(code === 0));
  p.on('error', () => resolve(false));
}));
app.on('will-quit', () => { try { watchProc?.kill(); } catch { /* */ } });
app.on('will-quit', stopSysAudio);

/* ---------- Логирование: система, загрузка, мост для renderer ---------- */
async function logSystemInfo() {
  try {
    log('flags', { file: FLAGS, enableFeatures: app.commandLine.getSwitchValue('enable-features') });
    log('start', {
      app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
      os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
      ramGB: Math.round(os.totalmem() / 1073741824), pid: process.pid,
    });
    log('gpu-features', app.getGPUFeatureStatus());
    const g = await app.getGPUInfo('complete');
    const devices = (g.gpuDevice || []).map((d) => ({
      active: d.active, vendor: d.vendorId, device: d.deviceId, driver: d.driverVersion, desc: d.description || d.deviceString,
    }));
    log('gpu', {
      devices,
      encode: (g.videoEncodeAcceleratorSupportedProfile || []).map((p) => `${p.profile}:${p.maxResolutionWidth}x${p.maxResolutionHeight}@${p.maxFramerateNumerator}`),
      decode: (g.videoDecodeAcceleratorSupportedProfile || []).length,
      aux: g.auxAttributes ? { glRenderer: g.auxAttributes.glRenderer, displayType: g.auxAttributes.displayType } : undefined,
    });
  } catch (e) { log('main-error', 'sysinfo: ' + e.message); }
}

let lastCpu = null;

/* ---------- Загрузка видеокарты (NVIDIA, через nvidia-smi из драйвера) ---------- */
let lastGpu = null;
let gpuOff = process.platform !== 'win32' && process.platform !== 'linux';
function pollGpu() {
  if (gpuOff) return;
  execFile('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 1800 }, (err, out) => {
    if (err) {
      if (err.code === 'ENOENT') { gpuOff = true; log('gpu', 'nvidia-smi не найден — загрузка видеокарты не пишется'); }
      lastGpu = null;
      return;
    }
    const v = String(out).split(/\r?\n/)[0].split(',').map((x) => Number(x.trim()));
    if (v.length >= 6 && v.every((x) => !Number.isNaN(x))) lastGpu = { util: v[0], enc: v[1], dec: v[2], memMB: v[3], memTotalMB: v[4], tempC: v[5] };
  });
}
setInterval(pollGpu, 2000);
ipcMain.handle('gpu-last', () => lastGpu);
function logCpu() {
  try {
    // загрузка всей системы (видно, сколько ест игра)
    const t = os.cpus().reduce((a, c) => { const tt = c.times; a.idle += tt.idle; a.total += tt.user + tt.nice + tt.sys + tt.idle + tt.irq; return a; }, { idle: 0, total: 0 });
    let sys = null;
    if (lastCpu) { const dt = t.total - lastCpu.total; sys = dt ? Math.round(100 * (1 - (t.idle - lastCpu.idle) / dt)) : null; }
    lastCpu = t;
    const per = {};
    for (const m of app.getAppMetrics()) {
      const k = m.type === 'Utility' ? (m.serviceName || m.name || 'Utility') : m.type;
      per[k] = Math.round(((per[k] || 0) + (m.cpu?.percentCPUUsage || 0)) * 10) / 10;
    }
    log('cpu', { systemPct: sys, app: per, freeRamMB: Math.round(os.freemem() / 1048576), gpu: lastGpu });
  } catch { /* ignore */ }
}

ipcMain.on('log', (_e, tag, data) => log(String(tag).slice(0, 20), data));
ipcMain.handle('open-logs', () => { fs.mkdirSync(logDir(), { recursive: true }); return shell.openPath(logDir()); });
ipcMain.handle('log-path', () => logFile);
ipcMain.handle('get-flags', () => FLAGS);
ipcMain.handle('set-flags', (_e, f) => {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'flags.json'), JSON.stringify({ ...readFlags(), ...f })); return true; } catch (e) { log('main-error', 'flags: ' + e.message); return false; }
});

/* =========================================================
   Друзья + диагностика сети
   ========================================================= */
let friends = null;
const upnp = new Upnp((t, d) => log(t, d));
const net = {
  port: 0, upnp: 'checking', upnpError: null, externalKind: null, ifacePublic: false,
  tailscale: false, stun: null, inboundConfirmed: [], outboundConfirmed: [], verdict: 'checking',
  stunMapped: null, natType: 'unknown', portPreserved: null,
};
let netConfigResolve;
const netConfigReady = new Promise((r) => { netConfigResolve = r; setTimeout(() => r({}), 4000); });
let upnpExternalIp = null;
let stunIp = null;

function sendWin(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function computeVerdict() {
  const inb = net.inboundConfirmed;
  if (inb.some((k) => k === 'upnp' || k === 'public' || k === 'stun')) net.verdict = 'ok-confirmed';
  else if (inb.includes('tailscale')) net.verdict = 'tailscale-confirmed';
  else if (net.ifacePublic) net.verdict = 'likely-ok';
  else if (net.upnp === 'ok' && net.externalKind === 'public' && net.stun !== 'mismatch') net.verdict = 'likely-ok';
  else if (net.stunMapped && net.natType === 'cone') net.verdict = 'punch-likely';
  else if (net.stunMapped && net.natType === 'symmetric') net.verdict = net.tailscale ? 'tailscale-only' : 'symmetric';
  else if (net.stunMapped === null || net.upnp === 'checking') net.verdict = 'checking';
  else if (net.externalKind === 'private' || net.externalKind === 'cgnat' || net.stun === 'mismatch') net.verdict = net.tailscale ? 'tailscale-only' : 'cgnat';
  else net.verdict = net.tailscale ? 'tailscale-only' : 'no-upnp';
}
function publishNet() {
  computeVerdict();
  log('net-check', net); // без IP-адресов
  sendWin('net-update', net);
}

function compareStun() {
  if (!stunIp || !upnpExternalIp) return;
  net.stun = stunIp === upnpExternalIp ? 'match' : 'mismatch';
}

async function startFriends() {
  friends = new FriendsNet({ dir: app.getPath('userData'), log: (t, d) => log(t, d), version: app.getVersion() });
  try {
    await friends.start();
  } catch (e) {
    log('friends-error', e.message);
    net.upnp = 'error'; net.upnpError = e.message; publishNet();
    return;
  }
  net.port = friends.port;
  const addrs = friends.localAddrs();
  net.ifacePublic = addrs.some((a) => a.kind === 'public');
  net.tailscale = addrs.some((a) => a.kind === 'tailscale');
  friends.on('friends', (list) => sendWin('friends-update', list));
  friends.on('message', (id, msg) => sendWin('friends-msg', { id, msg }));
  friends.on('fr', (e) => sendWin('friends-fr', e)); // код дружбы: запрос или ответ
  friends.on('probe-in', (_id, kind) => { if (!net.inboundConfirmed.includes(kind)) { net.inboundConfirmed.push(kind); publishNet(); } });
  friends.on('stun', (info) => {
    net.stunMapped = info.stun;
    net.friendsStun = info.used || null;
    net.natType = info.natType;
    net.portPreserved = info.portPreserved;
    net.ifacePublic = friends.localAddrs().some((a) => a.kind === 'public');
    publishNet();
  });
  netConfigReady.then((cfg) => {
    friends.setStunConfig(cfg);
    friendsStarted = true;
    if (cfg.noStun) { net.stunMapped = false; publishNet(); } else friends.startStun();
  });
  friends.on('probe-ok', (_id, kind) => { if (!net.outboundConfirmed.includes(kind)) { net.outboundConfirmed.push(kind); publishNet(); } });
  sendWin('friends-update', friends.list());
  publishNet();
  await runUpnp();
  // проверка «достучится ли друг» — для тех, кто в сети
  setTimeout(() => { for (const f of friends.list()) if (f.online) friends.probe(f.id); }, 3000);
}

async function runUpnp() {
  net.upnp = 'checking'; net.upnpError = null;
  try {
    const r = await upnp.init();
    if (!r.found) { net.upnp = 'no-router'; publishNet(); return; }
    if (!r.service) { net.upnp = 'no-service'; publishNet(); return; }
    upnpExternalIp = await upnp.externalIp().catch(() => null);
    const k = upnpExternalIp ? ipKind(upnpExternalIp) : null;
    net.externalKind = !k ? null : (k === 'public' ? 'public' : (k === 'tailscale' ? 'cgnat' : 'private'));
    compareStun();
    const m = await upnp.map(friends.port);
    net.upnp = 'ok';
    net.upnpPort = m.ext;
    if (net.externalKind === 'public') friends.setUpnp({ ip: upnpExternalIp, port: m.ext });
    if (m.lease) setInterval(() => upnp.map(friends.port).catch((e) => log('upnp', 'renew: ' + e.message)), 30 * 60 * 1000);
  } catch (e) {
    net.upnp = net.upnp === 'checking' ? 'map-failed' : net.upnp;
    net.upnpError = e.message;
  }
  publishNet();
  friends.pingAll();
}

ipcMain.handle('friends-info', () => (friends ? { id: friends.id, port: friends.port, addrs: friends.localAddrs(), list: friends.list() } : null));
ipcMain.handle('friends-add', (_e, f) => { const ok = friends?.addFriend(f); if (ok) setTimeout(() => friends.probe(f.id), 1500); return ok; });
ipcMain.handle('friends-remove', (_e, id) => friends?.removeFriend(id));
// код дружбы (ник — для кода и запроса)
// мой ник — сразу в сеть друзей (уходит в пингах)
ipcMain.handle('friends-nick', (_e, nick) => { if (!friends) return false; const was = friends.nick; friends.setNick(String(nick || '')); if (friends.nick !== was) friends.pingAll(); return true; });
ipcMain.handle('fc-make', (_e, nick) => { if (!friends?.id) return null; friends.setNick(nick); return friends.makeInvite(); });
ipcMain.handle('fc-parse', (_e, code) => friends?.parseCode(code) || { ok: false, error: 'bad' });
ipcMain.handle('fc-use', (_e, code, nick) => { if (!friends?.id) return { ok: false, error: 'bad' }; friends.setNick(nick); return friends.useCode(code); });
ipcMain.handle('fc-accept', (_e, id, nick) => { friends?.setNick(nick); return friends?.acceptRequest(id) || false; });
ipcMain.handle('fc-decline', (_e, id) => friends?.declineRequest(id));
ipcMain.handle('fc-cancel', (_e, id) => friends?.cancelOutgoing(id));
ipcMain.handle('fc-pending', () => friends?.pendingList() || { incoming: [], outgoing: [] });
ipcMain.handle('friends-proof', (_e, id, prover, nonce, bind) => friends?.proof(id, prover, nonce, bind) || null);
ipcMain.handle('friends-send', async (_e, id, msg) => {
  try { await friends.sendBig(id, msg); return { ok: true }; } catch (e) { log('friends', { sendFailed: msg?.t, error: e.message }); return { ok: false, error: e.message }; }
});
ipcMain.handle('friends-probe', (_e, id) => friends?.probe(id));
ipcMain.handle('friends-callpath', (_e, p) => {
  if (!friends || !p?.id) return;
  const r = friends.addCallHint(p.id, p.remoteIp) || {};
  log('net-check', {
    callPath: true, localType: p.localType, remoteType: p.remoteType,
    myStunMatchesCall: friends.stun && p.localType === 'srflx' ? friends.stun.ip === p.localIp : null,
    ...r,
  });
});
ipcMain.handle('net-get', () => net);
let friendsStarted = false;
ipcMain.handle('net-config', (_e, cfg) => {
  netConfigResolve(cfg || {});
  // настройки STUN поменяли на ходу — переопрашиваем с новыми серверами
  if (friendsStarted && friends) {
    friends.setStunConfig(cfg || {});
    clearInterval(friends.stunTimer);
    if (cfg?.noStun) { friends.stun = null; net.stunMapped = false; net.friendsStun = null; publishNet(); } else friends.startStun();
  }
});
ipcMain.handle('net-recheck', async () => { net.inboundConfirmed = []; net.outboundConfirmed = []; await runUpnp(); if (friends?.stunEnabled) await friends.runStun().then(() => { net.stunMapped = !!friends.stun; net.friendsStun = friends.stunUsed; net.natType = friends.natType; net.portPreserved = friends.stun ? friends.stun.port === friends.port : null; net.ifacePublic = friends.localAddrs().some((a) => a.kind === 'public'); }); friends?.punch(); for (const f of friends?.list() || []) if (f.online) friends.probe(f.id); return net; });
ipcMain.handle('net-stun', (_e, ip) => {
  if (!ip) { net.stun = 'unavailable'; } else { stunIp = ip; net.stun = null; compareStun(); if (!net.stun) net.stun = 'got'; }
  publishNet();
});
ipcMain.handle('focus-window', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.flashFrame(true); });
ipcMain.handle('app-quit', () => { appQuitting = true; app.quit(); });

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !upnp.mapped) { friends?.stop(); return; }
  e.preventDefault();
  quitting = true;
  Promise.race([upnp.unmap(), new Promise((r) => setTimeout(r, 1500))]).finally(() => { friends?.stop(); app.quit(); });
});

/* =========================================================
   Саундпад: звуки в %APPDATA%\alloconnect\sounds, горячие клавиши на каждый
   ========================================================= */
const SOUND_MAX = 15 * 1024 * 1024;
const SOUND_COUNT = 60;
function soundsDir() { return path.join(app.getPath('userData'), 'sounds'); }
function soundsIndex() { return path.join(soundsDir(), 'sounds.json'); }
function readSounds() {
  try {
    const d = JSON.parse(fs.readFileSync(soundsIndex(), 'utf-8'));
    return { list: Array.isArray(d.list) ? d.list : [], stopKey: d.stopKey ?? 'CommandOrControl+Alt+0' };
  } catch { return { list: [], stopKey: 'CommandOrControl+Alt+0' }; }
}
function writeSounds(d) {
  fs.mkdirSync(soundsDir(), { recursive: true });
  fs.writeFileSync(soundsIndex() + '.tmp', JSON.stringify(d, null, 1));
  fs.renameSync(soundsIndex() + '.tmp', soundsIndex());
}
/* ---------- Горячие клавиши программы: микрофон, звук, шумодав, повтор, метка, «убрать всё с экрана» ----------
   Сочетания — в hotkeys.json; пустая строка — клавиша выключена. */
const HOTKEY_DEFAULTS = {
  mute: 'CommandOrControl+Shift+M', deafen: 'CommandOrControl+Shift+D', ns: 'CommandOrControl+Shift+N',
  clip: 'CommandOrControl+Shift+C', mark: 'CommandOrControl+Shift+L', clear: 'CommandOrControl+Alt+End',
};
function hotkeysFile() { return path.join(app.getPath('userData'), 'hotkeys.json'); }
function readHotkeys() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(hotkeysFile(), 'utf-8')) || {}; } catch { /* */ }
  const out = {};
  for (const k of Object.keys(HOTKEY_DEFAULTS)) out[k] = typeof saved[k] === 'string' ? saved[k].slice(0, 60) : HOTKEY_DEFAULTS[k];
  return out;
}
let appKeys = [];
let appKeysBusy = [];
function registerAppHotkeys() {
  for (const k of appKeys) { try { globalShortcut.unregister(k); } catch { /* */ } }
  appKeys = [];
  appKeysBusy = [];
  const keys = readHotkeys();
  for (const [what, acc] of Object.entries(keys)) {
    if (!acc) continue;
    const fire = what === 'mark'
      ? () => { log('MARK', '===== пользователь отметил момент (лаг) ====='); win?.webContents.send('hotkey', 'mark'); }
      : () => win?.webContents.send('hotkey', what);
    try { if (globalShortcut.register(acc, fire)) appKeys.push(acc); else appKeysBusy.push(what); } catch { appKeysBusy.push(what); }
  }
  if (appKeysBusy.length) log('hotkeys', { busy: appKeysBusy });
}
ipcMain.handle('hotkeys-get', () => ({ keys: readHotkeys(), defaults: HOTKEY_DEFAULTS, busy: appKeysBusy, stopKey: readSounds().stopKey }));
ipcMain.handle('hotkeys-set', (_e, what, acc) => {
  if (!Object.prototype.hasOwnProperty.call(HOTKEY_DEFAULTS, what)) return { ok: false };
  acc = String(acc ?? HOTKEY_DEFAULTS[what]).slice(0, 60);
  const keys = readHotkeys();
  // одно сочетание — одно действие: у прежнего владельца снимаем
  if (acc) for (const k of Object.keys(keys)) if (k !== what && keys[k] === acc) keys[k] = '';
  keys[what] = acc;
  try { fs.writeFileSync(hotkeysFile(), JSON.stringify(keys, null, 1)); } catch (e) { log('main-error', 'hotkeys: ' + e.message); }
  registerAppHotkeys();
  registerSoundHotkeys();
  return { ok: !appKeysBusy.includes(what), keys: readHotkeys() };
});

let soundKeys = [];
function registerSoundHotkeys() {
  for (const k of soundKeys) { try { globalShortcut.unregister(k); } catch { /* */ } }
  soundKeys = [];
  const d = readSounds();
  const failed = [];
  const reg = (acc, what) => {
    if (!acc) return;
    try {
      if (globalShortcut.register(acc, () => win?.webContents.send('hotkey', what))) soundKeys.push(acc);
      else failed.push(acc);
    } catch { failed.push(acc); }
  };
  reg(d.stopKey, 'sound-stop');
  for (const s of d.list) reg(s.hotkey, 'sound:' + s.id);
  if (failed.length) log('soundpad', { hotkeysBusy: failed });
  return failed;
}
ipcMain.handle('sounds-list', () => readSounds());
ipcMain.handle('sounds-add', (_e, bytes, name) => {
  const d = readSounds();
  if (d.list.length >= SOUND_COUNT) throw new Error(`не больше ${SOUND_COUNT} звуков`);
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > SOUND_MAX) throw new Error('файл больше 15 МБ');
  const ext = (/\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)$/i.exec(String(name)) || [, 'bin'])[1].toLowerCase();
  const id = require('crypto').randomBytes(5).toString('hex');
  fs.mkdirSync(soundsDir(), { recursive: true });
  fs.writeFileSync(path.join(soundsDir(), `${id}.${ext}`), buf);
  const entry = { id, name: String(name).replace(/\.[^.]+$/, '').slice(0, 40) || 'звук', file: `${id}.${ext}`, vol: 100, hotkey: '' };
  d.list.push(entry);
  writeSounds(d);
  log('soundpad', { added: entry.id, size: buf.length });
  return entry;
});
ipcMain.handle('sounds-remove', (_e, id) => {
  const d = readSounds();
  const s = d.list.find((x) => x.id === id);
  if (s) { try { fs.unlinkSync(path.join(soundsDir(), s.file)); } catch { /* */ } }
  d.list = d.list.filter((x) => x.id !== id);
  writeSounds(d);
  registerSoundHotkeys();
  return true;
});
ipcMain.handle('sounds-update', (_e, id, patch) => {
  const d = readSounds();
  if (id === '__stop') { d.stopKey = String(patch.hotkey || '').slice(0, 60); }
  else {
    const s = d.list.find((x) => x.id === id);
    if (!s) return { ok: false };
    if (patch.name != null) s.name = String(patch.name).slice(0, 40);
    if (patch.vol != null) s.vol = Math.max(0, Math.min(200, Number(patch.vol) || 0));
    if (patch.hotkey != null) s.hotkey = String(patch.hotkey).slice(0, 60);
  }
  // одна клавиша — один звук
  if (patch.hotkey) for (const o of d.list) if (o.id !== id && o.hotkey === patch.hotkey) o.hotkey = '';
  if (patch.hotkey && id !== '__stop' && d.stopKey === patch.hotkey) d.stopKey = '';
  writeSounds(d);
  const failed = patch.hotkey != null ? registerSoundHotkeys() : [];
  return { ok: !failed.includes(patch.hotkey), busy: failed };
});
ipcMain.handle('sounds-read', (_e, id) => {
  const s = readSounds().list.find((x) => x.id === id);
  if (!s) throw new Error('нет звука');
  return fs.readFileSync(path.join(soundsDir(), s.file));
});

// Свой звук звонка: хранится в папке данных alloconnect
const RING_MAX = 25 * 1024 * 1024;
function ringFile() { return path.join(app.getPath('userData'), 'ringtone.bin'); }
ipcMain.handle('ringtone-save', (_e, bytes, mime, name) => {
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > RING_MAX) throw new Error('файл слишком большой (до 25 МБ)');
  fs.writeFileSync(ringFile(), buf);
  fs.writeFileSync(ringFile() + '.json', JSON.stringify({ mime: String(mime || 'audio/mpeg').slice(0, 60), name: String(name || '').slice(0, 120) }));
  log('settings', { ringtone: 'custom', size: buf.length });
  return true;
});
ipcMain.handle('ringtone-load', () => {
  try {
    const meta = JSON.parse(fs.readFileSync(ringFile() + '.json', 'utf-8'));
    return { bytes: fs.readFileSync(ringFile()), ...meta };
  } catch { return null; }
});
ipcMain.handle('ringtone-clear', () => { for (const f of [ringFile(), ringFile() + '.json']) { try { fs.unlinkSync(f); } catch { /* */ } } return true; });

// Файлы из папки приложения (WASM шумодава) — fetch() для file:// не работает
ipcMain.handle('read-asset', (_e, rel) => {
  if (!/^vendor\/[\w.-]+\.wasm$/.test(String(rel))) throw new Error('bad asset');
  return fs.readFileSync(path.join(__dirname, rel));
});

/* =========================================================
   Оверлей поверх экрана стримящего: указка, рисунки друга, реакции, картинки, плашка управления.
   Прозрачное окно поверх показываемого экрана/окна, не ловит мышь и исключено из захвата
   (друг не видит его в стриме дважды). Показывается только когда есть что показать.
   ========================================================= */
let ovl = null;
let ovlCtx = null;          // { kind: 'screen'|'window', bounds, minimized }
let ovlHideTimer = null;
let ovlPinned = false;      // идёт управление — плашка висит постоянно
function winBuild() { const m = /^10\.0\.(\d+)/.exec(os.release()); return m ? Number(m[1]) : 0; }

function createOverlay() {
  if (ovl && !ovl.isDestroyed()) return ovl;
  ovl = new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
    minimizable: false, maximizable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    fullscreenable: false, title: 'alloconnect-overlay', width: 800, height: 600,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  ovl.setIgnoreMouseEvents(true);
  ovl.setAlwaysOnTop(true, 'screen-saver');
  try { ovl.setContentProtection(true); } catch { /* */ }
  ovl.loadFile('overlay.html');
  ovl.on('closed', () => { ovl = null; });
  return ovl;
}
function ovlApplyBounds() {
  if (!ovl || ovl.isDestroyed() || !ovlCtx?.bounds) return;
  const b = ovlCtx.bounds;
  ovl.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(50, Math.round(b.width)), height: Math.max(50, Math.round(b.height)) });
}
function ovlShow() {
  if (!ovl || ovl.isDestroyed() || !ovlCtx?.bounds || ovlCtx.minimized) return;
  if (!ovl.isVisible()) { ovlApplyBounds(); ovl.showInactive(); ovl.setAlwaysOnTop(true, 'screen-saver'); }
  clearTimeout(ovlHideTimer);
  // видео от друга играет до минуты — не прячем оверлей раньше
  if (!ovlPinned) ovlHideTimer = setTimeout(() => { if (ovl && !ovl.isDestroyed() && !ovlPinned) ovl.hide(); }, Math.max(8000, ovlHoldUntil - Date.now()));
}
let ovlHoldUntil = 0;
let lastWatchRect = null;
let lastWatchState = 'normal';
const toDip = (r) => (process.platform === 'win32' ? screen.screenToDipRect(null, r) : r);
function onWatchRect(v) {
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return;
  lastWatchRect = { x: v[0], y: v[1], width: v[2], height: v[3] };
  if (!ovlCtx || ovlCtx.kind !== 'window') return;
  ovlCtx.bounds = toDip(lastWatchRect);
  ovlApplyBounds();
}
function onWatchState(st) {
  lastWatchState = st;
  if (!ovlCtx || ovlCtx.kind !== 'window') return;
  ovlCtx.minimized = st !== 'normal';
  if (ovlCtx.minimized && ovl && !ovl.isDestroyed()) ovl.hide();
  else if (!ovlCtx.minimized && ovlPinned) ovlShow();
}
function displayFor(sourceId) {
  const did = sourceDisplay.get(sourceId);
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === did) || screen.getPrimaryDisplay();
}
ipcMain.handle('ovl-open', (_e, sourceId) => {
  const isWin = /^window:/.test(String(sourceId));
  // на старой Windows окно нельзя исключить из захвата — у друга был бы чёрный прямоугольник
  if (process.platform === 'win32' && !isWin && winBuild() < 19041) { log('overlay', { skipped: 'old-windows' }); return { ok: false, reason: 'old-windows' }; }
  ovlCtx = isWin
    ? { kind: 'window', bounds: lastWatchRect ? toDip(lastWatchRect) : null, minimized: lastWatchState !== 'normal' }
    : { kind: 'screen', bounds: displayFor(sourceId).bounds, minimized: false };
  ovlPinned = false;
  createOverlay();
  ovlApplyBounds();
  log('overlay', { open: ovlCtx.kind });
  return { ok: true };
});
// показ всего экрана: окно alloconnect прячем из захвата — иначе превью стрима снимает само себя (эффект зеркала)
ipcMain.handle('capture-hide', (_e, on) => { try { win?.setContentProtection(!!on); log('share', { hideOwnWindow: !!on }); return true; } catch { return false; } });
ipcMain.handle('ovl-close', () => {
  ovlCtx = null;
  ovlPinned = false;
  clearTimeout(ovlHideTimer);
  if (ovl && !ovl.isDestroyed()) ovl.destroy();
  ovl = null;
});
ipcMain.on('ovl-msg', (_e, msg) => {
  if (!ovl || ovl.isDestroyed() || !msg || typeof msg !== 'object') return;
  if (msg.t === 'pin') { ovlPinned = !!msg.on; if (!ovlPinned) clearTimeout(ovlHideTimer); }
  if (msg.t === 'vid') ovlHoldUntil = Date.now() + 63000;
  ovl.webContents.send('ovl', msg);
  const content = ['stroke', 'ptr', 'react', 'img', 'vid'].includes(msg.t) || (msg.t === 'pin' && msg.on);
  if (content) ovlShow();
  else if (msg.t === 'pin' && ovl.isVisible()) { clearTimeout(ovlHideTimer); ovlHideTimer = setTimeout(() => { if (ovl && !ovl.isDestroyed() && !ovlPinned) ovl.hide(); }, 4000); }
});
ipcMain.handle('win-build', () => (process.platform === 'win32' ? winBuild() : 0));

/* =========================================================
   Приглушение других программ, пока идёт разговор (как в Discord)
   ========================================================= */
let duckProc = null;
let duckLevel = 1;
function duckStart() {
  if (duckProc || !helperUsable()) return;
  try {
    duckProc = spawnHelper(['duck', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (e) { log('duck', { spawnFailed: e.message }); duckProc = null; return; }
  const p = duckProc;
  p.stderr.on('data', (d) => { const t = d.toString().trim(); if (t !== 'OK') log('duck', 'stderr: ' + t.slice(0, 200)); });
  p.on('error', (e) => log('duck', { error: e.message }));
  p.on('exit', (code) => { log('duck', { exit: code }); if (duckProc === p) duckProc = null; });
  p.stdin.on('error', () => {});
  log('duck', { started: true });
}
function duckStop() {
  const p = duckProc;
  if (!p) return;
  duckProc = null;
  duckLevel = 1;
  // не убиваем сразу: помощник сам вернёт громкость на место, когда закроется stdin
  try { p.stdin.end(); } catch { /* */ }
  setTimeout(() => { try { p.kill(); } catch { /* */ } }, 3000);
}
ipcMain.handle('duck-set', (_e, level) => {
  const v = Math.max(0, Math.min(1, Number(level)));
  if (!Number.isFinite(v)) return;
  if (v < 1) duckStart();
  if (!duckProc) return;
  if (Math.abs(v - duckLevel) < 0.005) return;
  duckLevel = v;
  try { duckProc.stdin.write(`level ${v.toFixed(3)}\n`); } catch { /* */ }
});
ipcMain.handle('duck-stop', () => duckStop());
app.on('will-quit', duckStop);

/* =========================================================
   Удалённое управление: друг двигает мышью, жмёт клавиши и геймпад у того, кто стримит.
   Включается только после «Разрешить» на этом компьютере; Ctrl+Shift+X — забрать сразу.
   ========================================================= */
let inputProc = null;
const STOP_KEY = 'CommandOrControl+Shift+X';
function inputStop(reason) {
  const p = inputProc;
  if (!p) return;
  inputProc = null;
  try { globalShortcut.unregister(STOP_KEY); } catch { /* */ }
  try { p.stdin.write('rel\n'); p.stdin.end(); } catch { /* */ }
  setTimeout(() => { try { p.kill(); } catch { /* */ } }, 1500);
  log('control', { stop: reason || 'renderer' });
}
ipcMain.handle('input-start', (_e, { sourceId, perm }) => new Promise((resolve) => {
  inputStop('restart');
  if (!helperUsable()) return resolve({ ok: false, error: process.platform === 'win32' ? 'нет alloconnect-helper.exe' : 'только Windows' });
  let p;
  try { p = spawnHelper(['input', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ ok: false, error: e.message }); }
  inputProc = p;
  p.stdin.on('error', () => {});
  const w = (l) => { try { p.stdin.write(l + '\n'); } catch { /* */ } };
  const hwnd = hwndOf(sourceId);
  if (hwnd) w(`areawin ${hwnd}`);
  else {
    const d = displayFor(sourceId);
    const r = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    w(`area ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}`);
  }
  w(`perm ${perm?.mouse ? 1 : 0} ${perm?.kb ? 1 : 0} ${perm?.pad ? 1 : 0}`);
  let settled = false;
  const done = (r) => { if (!settled) { settled = true; resolve(r); } };
  const t = setTimeout(() => done({ ok: false, error: 'помощник не ответил' }), 4000);
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('OK')) { clearTimeout(t); done({ ok: true, admin: /admin/.test(line) }); continue; }
      if (line !== 'local' && !line.startsWith('rumble')) log('control', { helper: line });
      if (inputProc === p) sendWin('input-evt', line);
    }
  });
  p.stderr.on('data', (d) => log('control', 'stderr: ' + d.toString().trim().slice(0, 200)));
  p.on('error', (e) => { clearTimeout(t); done({ ok: false, error: e.message }); });
  p.on('exit', (code) => {
    clearTimeout(t);
    done({ ok: false, error: 'помощник завершился, код ' + code });
    if (inputProc === p) { inputProc = null; try { globalShortcut.unregister(STOP_KEY); } catch { /* */ } sendWin('input-evt', 'exit'); }
  });
  try { globalShortcut.register(STOP_KEY, () => { sendWin('hotkey', 'ctl-stop'); inputStop('hotkey'); }); } catch { /* */ }
  log('control', { start: hwnd ? 'window' : 'screen', perm });
}));
const INPUT_RE = /^(m -?\d+(\.\d+)? -?\d+(\.\d+)?|r -?\d+ -?\d+|b [0-4] [01]|w -?\d+ -?\d+|k \d{1,3} [01] [01]|pad \d+ \d+ \d+ -?\d+ -?\d+ -?\d+ -?\d+|padoff|rel|perm [01] [01] [01])$/;
ipcMain.on('input-cmd', (_e, line) => {
  if (!inputProc || typeof line !== 'string' || !INPUT_RE.test(line)) return;
  try { inputProc.stdin.write(line + '\n'); } catch { /* */ }
});
ipcMain.handle('input-stop', () => inputStop('renderer'));
app.on('will-quit', () => inputStop('quit'));

/* =========================================================
   История чатов: %APPDATA%\alloconnect\history\<ID друга>\log.jsonl + media\
   Хранится только на этом компьютере. В логи не попадает.
   ========================================================= */
const ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
function histDir(id) { if (!ID_RE.test(String(id))) throw new Error('bad id'); return path.join(app.getPath('userData'), 'history', id); }
function histRead(id) {
  const f = path.join(histDir(id), 'log.jsonl');
  let text;
  try { text = fs.readFileSync(f, 'utf-8'); } catch { return []; }
  let lines = text.split('\n').filter(Boolean);
  if (text.length > 4 * 1024 * 1024) { // ограничиваем размер — оставляем последние 3000 записей
    lines = lines.slice(-3000);
    try { fs.writeFileSync(f, lines.join('\n') + '\n'); } catch { /* */ }
  }
  const out = [];
  const byMid = new Map();
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'status') { const t = byMid.get(e.ref); if (t) t.st = e.st; continue; }
    if (e.type === 'op') { // реакции, правки, удаление
      const t = byMid.get(e.ref);
      if (!t || t.deleted) continue;
      if (e.op === 'react') { t.react = { ...(t.react || {}) }; if (e.e) t.react[e.who] = e.e; else delete t.react[e.who]; }
      else if (e.who === t.who && e.op === 'edit' && t.type === 'text') { t.text = String(e.text || '').slice(0, 2000); t.edited = e.ts; }
      else if (e.who === t.who && e.op === 'del') { t.deleted = true; t.text = ''; t.react = {}; if (t.file) t.file = { ...t.file, name: '', stored: undefined }; }
      continue;
    }
    out.push(e);
    if (e.mid) byMid.set(e.mid, e);
  }
  return out;
}
ipcMain.handle('hist-load', (_e, id, limit, before) => {
  const all = histRead(id);
  const end = before == null ? all.length : Math.max(0, Math.min(all.length, Number(before)));
  const start = Math.max(0, end - (Number(limit) || 150));
  return { items: all.slice(start, end), start };
});
ipcMain.handle('hist-append', (_e, id, entry) => {
  const line = JSON.stringify(entry);
  if (line.length > 20000) return false;
  fs.mkdirSync(histDir(id), { recursive: true });
  // удаление: сохранённую картинку стираем с диска сразу
  if (entry?.type === 'op' && entry.op === 'del') {
    const t = histRead(id).find((x) => x.mid === entry.ref);
    if (t?.file?.stored && t.who === entry.who && /^media\/[a-f0-9]{16}\.[a-z0-9]{1,5}$/.test(t.file.stored)) { try { fs.unlinkSync(path.join(histDir(id), t.file.stored)); } catch { /* */ } }
  }
  fs.appendFileSync(path.join(histDir(id), 'log.jsonl'), line + '\n');
  return true;
});
ipcMain.handle('hist-search', (_e, id, q) => {
  const s = String(q || '').trim().toLowerCase().slice(0, 100);
  if (s.length < 2) return [];
  const all = histRead(id);
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < 100; i--) {
    const e = all[i];
    if (e.deleted) continue;
    const t = e.type === 'text' ? e.text : e.type === 'file' ? e.file?.name : '';
    if (t && String(t).toLowerCase().includes(s)) out.push({ i, mid: e.mid, ts: e.ts, who: e.who, nick: e.nick, text: String(t).slice(0, 300), file: e.type === 'file' });
  }
  return out;
});
ipcMain.handle('hist-media-save', (_e, id, bytes, name) => {
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > 210 * 1024 * 1024) throw new Error('too big');
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(String(name || '')) || [, 'bin'])[1].toLowerCase();
  const rel = `media/${require('crypto').randomBytes(8).toString('hex')}.${ext}`;
  fs.mkdirSync(path.join(histDir(id), 'media'), { recursive: true });
  fs.writeFileSync(path.join(histDir(id), rel), buf);
  return rel;
});
ipcMain.handle('hist-media-read', (_e, id, rel) => {
  if (!/^media\/[a-f0-9]{16}\.[a-z0-9]{1,5}$/.test(String(rel))) throw new Error('bad path');
  return fs.readFileSync(path.join(histDir(id), rel));
});
ipcMain.handle('hist-clear', (_e, id) => {
  const dir = id ? histDir(id) : path.join(app.getPath('userData'), 'history');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { log('main-error', 'hist-clear: ' + e.message); return false; }
  return true;
});

/* =========================================================
   Аватарки: своя — avatar.bin, друзей — avatars\<ID>.bin
   ========================================================= */
const AVATAR_MAX = 2 * 1024 * 1024;
const AV_MIME = /^image\/(png|jpeg|webp|gif)$/;
function avPaths(id) {
  if (id == null) return { bin: path.join(app.getPath('userData'), 'avatar.bin'), meta: path.join(app.getPath('userData'), 'avatar.json') };
  if (!ID_RE.test(String(id))) throw new Error('bad id');
  const d = path.join(app.getPath('userData'), 'avatars');
  return { bin: path.join(d, id + '.bin'), meta: path.join(d, id + '.json') };
}
function avRead(id) {
  try {
    const p = avPaths(id);
    const meta = JSON.parse(fs.readFileSync(p.meta, 'utf-8'));
    return { bytes: fs.readFileSync(p.bin), mime: meta.mime, hash: meta.hash };
  } catch { return null; }
}
function avWrite(id, bytes, mime) {
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > AVATAR_MAX || !AV_MIME.test(String(mime))) throw new Error('bad avatar');
  const p = avPaths(id);
  fs.mkdirSync(path.dirname(p.bin), { recursive: true });
  const hash = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16);
  fs.writeFileSync(p.bin, buf);
  fs.writeFileSync(p.meta, JSON.stringify({ mime, hash }));
  return hash;
}
ipcMain.handle('avatar-mine', () => avRead(null));
ipcMain.handle('avatar-set-mine', (_e, bytes, mime) => avWrite(null, bytes, mime));
ipcMain.handle('avatar-clear-mine', () => { const p = avPaths(null); for (const f of [p.bin, p.meta]) { try { fs.unlinkSync(f); } catch { /* */ } } return true; });
ipcMain.handle('avatar-get', (_e, id) => avRead(id));
ipcMain.handle('avatar-save', (_e, id, bytes, mime) => avWrite(id, bytes, mime));
ipcMain.handle('avatar-drop', (_e, id) => { const p = avPaths(id); for (const f of [p.bin, p.meta]) { try { fs.unlinkSync(f); } catch { /* */ } } return true; });

/* =========================================================
   Push-to-talk: глобально ловим нажатие и ОТПУСКАНИЕ клавиши (помощник с хуком клавиатуры)
   ========================================================= */
let keysProc = null;
function keysStop() { const p = keysProc; keysProc = null; if (p) { try { p.stdin.end(); } catch { /* */ } setTimeout(() => { try { p.kill(); } catch { /* */ } }, 500); } }
ipcMain.handle('ptt-set', (_e, vks) => new Promise((resolve) => {
  keysStop();
  const list = (Array.isArray(vks) ? vks : []).map(Number).filter((v) => v > 0 && v < 256);
  if (!list.length) return resolve({ ok: true });
  if (!helperUsable()) return resolve({ ok: false, error: 'только Windows' });
  let p;
  try { p = spawnHelper(['keys', list.join(',')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ ok: false, error: e.message }); }
  keysProc = p;
  p.stdin.on('error', () => {});
  let settled = false;
  const done = (r) => { if (!settled) { settled = true; resolve(r); } };
  setTimeout(() => done({ ok: false, error: 'помощник не ответил' }), 3000);
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'OK') { done({ ok: true }); continue; }
      const m = /^(down|up) (\d+)$/.exec(line);
      if (m && keysProc === p) sendWin('ptt', { down: m[1] === 'down', vk: Number(m[2]) });
    }
  });
  p.stderr.on('data', (d) => log('ptt', 'stderr: ' + d.toString().trim().slice(0, 200)));
  p.on('exit', (code) => { done({ ok: false, error: 'помощник завершился, код ' + code }); if (keysProc === p) keysProc = null; });
  log('ptt', { keys: list.length });
}));
app.on('will-quit', keysStop);

/* =========================================================
   «Играет в …»: полноэкранное окно на переднем плане (не браузер и не видеоплеер)
   Видят только друзья — через свой зашифрованный канал. В лог название игры не пишем.
   ========================================================= */
const NOT_GAMES = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'browser.exe', 'brave.exe', 'vivaldi.exe', 'iexplore.exe',
  'vlc.exe', 'mpc-hc.exe', 'mpc-hc64.exe', 'mpc-be.exe', 'mpc-be64.exe', 'potplayermini.exe', 'potplayermini64.exe', 'mpv.exe', 'wmplayer.exe',
  'explorer.exe', 'alloconnect.exe', 'electron.exe', 'telegram.exe', 'discord.exe', 'steamwebhelper.exe', 'applicationframehost.exe',
  'powerpnt.exe', 'acrord32.exe', 'acrobat.exe', 'obs64.exe', 'lockapp.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'video.ui.exe', 'microsoft.media.player.exe']);
let fgProc = null;
let activity = null;
function setActivity(a) {
  const same = JSON.stringify(a) === JSON.stringify(activity);
  activity = a;
  if (same) return;
  friends?.setActivity(a);
  sendWin('activity', a);
}
ipcMain.handle('fg-set', (_e, on) => {
  if (fgProc) { const p = fgProc; fgProc = null; try { p.stdin.end(); p.kill(); } catch { /* */ } }
  if (!on || !helperUsable()) { setActivity(null); return false; }
  const p = spawnHelper(['fg', 'x'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  fgProc = p;
  p.stdin.on('error', () => {});
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString('utf-8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (fgProc !== p) continue;
      const parts = line.split('\t');
      if (parts[0] !== 'fg 1') { setActivity(null); continue; }
      const exe = String(parts[1] || '').toLowerCase();
      if (!exe || NOT_GAMES.has(exe)) { setActivity(null); continue; }
      const title = String(parts[2] || '').trim() || exe.replace(/\.exe$/, '');
      setActivity({ game: title.slice(0, 48) });
    }
  });
  p.on('exit', () => { if (fgProc === p) { fgProc = null; setActivity(null); } });
  return true;
});
ipcMain.handle('activity-get', () => activity);
app.on('will-quit', () => { try { fgProc?.kill(); } catch { /* */ } });

/* =========================================================
   Клипы (повтор последних секунд): «Видео\alloconnect»
   ========================================================= */
function clipsDir() { return path.join(app.getPath('videos'), 'alloconnect'); }
ipcMain.handle('clip-save', (_e, bytes, ext) => {
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > 1024 * 1024 * 1024) throw new Error('bad clip');
  fs.mkdirSync(clipsDir(), { recursive: true });
  const name = `клип-${ts().replace(/[: ]/g, '-').replace(/\.\d+$/, '')}.${/^(mp4|webm)$/.test(ext) ? ext : 'mp4'}`;
  const file = path.join(clipsDir(), name);
  fs.writeFileSync(file, buf);
  log('clip', { saved: true, mb: Math.round(buf.length / 104857.6) / 10 });
  return { file, name };
});
ipcMain.handle('clip-show', (_e, file) => {
  const f = String(file || '');
  if (f && path.dirname(f) === clipsDir() && fs.existsSync(f)) shell.showItemInFolder(f);
  else { fs.mkdirSync(clipsDir(), { recursive: true }); shell.openPath(clipsDir()); }
});

/* =========================================================
   Обновления от друга. Каждая сборка несёт update.json — описание своих файлов
   (код программы и помощник), подписанное ключом автора (Ed25519). Друг скачивает эти файлы
   напрямую, проверяет подпись и хэши; ставится только по согласию, старая версия остаётся для отката.
   ========================================================= */
const UPDATE_PUBKEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVxeX/idMDcAM3em0CPMWYKLjwvhtw71OC/AZqqhntqo=\n-----END PUBLIC KEY-----\n';
const UPDATE_FILES = ['app.asar', 'alloconnect-helper.exe'];
const crypto2 = require('crypto');
// original-fs читает/пишет файлы как есть, без вмешательства asar (иначе app.asar не прочитать)
let ofs; try { ofs = require('original-fs'); } catch { ofs = fs; }
// ALOCALLS_UPDATE_DIR — только для автотестов: папка с «установленными» файлами вместо resources
const resDir = () => process.env.ALOCALLS_UPDATE_DIR || process.resourcesPath || '';
function verCmp(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}
// проверка подписи и содержимого описания обновления
function checkManifest(m, sig) {
  if (typeof m !== 'string' || typeof sig !== 'string' || m.length > 4000) return { ok: false, error: 'плохое описание' };
  let good = false;
  try { good = crypto2.verify(null, Buffer.from(m, 'utf-8'), crypto2.createPublicKey(UPDATE_PUBKEY), Buffer.from(sig, 'base64')); } catch { good = false; }
  if (!good) return { ok: false, error: 'подпись не сходится' };
  let man;
  try { man = JSON.parse(m); } catch { return { ok: false, error: 'плохое описание' }; }
  if (man.app !== 'alloconnect' || !/^\d+\.\d+\.\d+$/.test(String(man.v)) || !Array.isArray(man.files)) return { ok: false, error: 'плохое описание' };
  if (man.files.length !== UPDATE_FILES.length || !man.files.every((f) => UPDATE_FILES.includes(f.n) && /^[a-f0-9]{64}$/.test(f.sha256) && f.size > 0 && f.size < 80 * 1024 * 1024)) return { ok: false, error: 'плохой список файлов' };
  return { ok: true, man };
}
let ownUpdate = null; // { m, sig, man }
function loadOwnUpdate() {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(resDir(), 'update.json'), 'utf-8'));
    const c = checkManifest(u.m, u.sig);
    if (c.ok && c.man.v === app.getVersion()) ownUpdate = { m: u.m, sig: u.sig, man: c.man };
    else log('update', { ownManifest: c.ok ? 'other-version' : c.error });
  } catch { /* сборка без подписи — раздавать нечего */ }
}
function stagingDir() { return path.join(app.getPath('userData'), 'update-staging'); }
const sha256File = (f) => crypto2.createHash('sha256').update(ofs.readFileSync(f)).digest('hex');
let staged = null; // { man, m, sig, dir, got: Set }

ipcMain.handle('upd-own', () => ({ v: app.getVersion(), electron: process.versions.electron, can: !!ownUpdate, packaged: app.isPackaged || !!FAKE_HELPER }));
ipcMain.handle('upd-offer', () => (ownUpdate ? { m: ownUpdate.m, sig: ownUpdate.sig } : null));
ipcMain.handle('upd-read', (_e, name) => {
  if (!ownUpdate || !UPDATE_FILES.includes(name)) throw new Error('нет такого файла');
  return ofs.readFileSync(path.join(resDir(), name));
});
// начать приём обновления от друга
ipcMain.handle('upd-stage-begin', (_e, m, sig) => {
  const c = checkManifest(m, sig);
  if (!c.ok) { log('update', { rejected: c.error }); return c; }
  if (verCmp(c.man.v, app.getVersion()) <= 0) return { ok: false, error: 'не новее моей' };
  if (c.man.electron !== process.versions.electron) return { ok: false, error: 'manual', v: c.man.v }; // сменился «движок» — только вручную
  if (staged && staged.man.v === c.man.v && staged.got.size === UPDATE_FILES.length) return { ok: true, ready: true, v: c.man.v };
  const dir = path.join(stagingDir(), c.man.v);
  try { fs.rmSync(stagingDir(), { recursive: true, force: true }); } catch { /* */ }
  fs.mkdirSync(dir, { recursive: true });
  staged = { man: c.man, m, sig, dir, got: new Set() };
  log('update', { staging: c.man.v });
  return { ok: true, v: c.man.v };
});
ipcMain.handle('upd-stage-file', (_e, name, bytes) => {
  if (!staged) return { ok: false, error: 'не ждём' };
  const f = staged.man.files.find((x) => x.n === name);
  if (!f) return { ok: false, error: 'лишний файл' };
  const buf = Buffer.from(bytes);
  const hash = crypto2.createHash('sha256').update(buf).digest('hex');
  if (buf.length !== f.size || hash !== f.sha256) { log('update', { badFile: name }); return { ok: false, error: 'файл повреждён' }; }
  ofs.writeFileSync(path.join(staged.dir, name), buf);
  staged.got.add(name);
  const ready = staged.got.size === UPDATE_FILES.length;
  if (ready) { fs.writeFileSync(path.join(staged.dir, 'update.json'), JSON.stringify({ m: staged.m, sig: staged.sig })); log('update', { ready: staged.man.v }); }
  return { ok: true, ready, v: staged.man.v };
});
/* ---------- Обновления с GitHub: тот же подписанный update.json, только скачанный из релиза ----------
   Подпись и хэши проверяются так же, как у обновления от друга — подменённый файл не поставится. */
const GH_REPO = 'kepilis/alloconnect'; // «ник/репозиторий» на GitHub, откуда брать релизы
const { net: enet } = require('electron');
// ALOCALLS_GH_API — только для автотестов (подставной GitHub на этом же ПК)
const GH_API = process.env.ALOCALLS_GH_API || 'https://api.github.com';
const GH_RAW = process.env.ALOCALLS_GH_RAW || 'https://raw.githubusercontent.com';
let ghBusy = null;
async function ghGet(url, asJson) {
  const r = await enet.fetch(url, { headers: { 'User-Agent': 'alloconnect', Accept: asJson ? 'application/vnd.github+json' : 'application/octet-stream' }, cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 404 ? 'обновлений пока нет' : 'GitHub ответил ' + r.status);
  return asJson ? r.json() : Buffer.from(await r.arrayBuffer());
}
/* ---------- Картинка, перетащенная из браузера ссылкой (не файлом) ----------
   Не все браузеры отдают при перетаскивании сам файл — часто только адрес картинки. Качаем здесь, без CORS. */
const DROP_MAX = 100 * 1024 * 1024;
// страница (пин Pinterest и т. п.) вместо файла: ищем в ней настоящее видео, иначе картинку страницы
function mediaFromPage(html, base) {
  const un = (s) => String(s).replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const abs = (s) => { try { return new URL(un(s), base).href; } catch { return null; } };
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
    const tag = re.exec(html)?.[0];
    return tag ? /content=["']([^"']+)["']/i.exec(tag)?.[1] || null : null;
  };
  const found = [];
  // Pinterest: видео лежит mp4 на pinimg.com (720p лучше, hls/m3u8 не годится)
  const pins = [...html.matchAll(/https?:(?:\\?\/){2}v\d*\.pinimg\.com(?:\\?\/)videos(?:\\?\/)[^"'\s<>]+?\.mp4/gi)].map((m) => un(m[0]));
  pins.sort((a, b) => (/720p/.test(b) ? 1 : 0) - (/720p/.test(a) ? 1 : 0));
  found.push(...pins);
  for (const p of ['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']) { const v = meta(p); if (v) found.push(v); }
  for (const m of html.matchAll(/"contentUrl"\s*:\s*"([^"]+\.(?:mp4|webm|mov)[^"]*)"/gi)) found.push(m[1]);
  for (const m of html.matchAll(/<(?:video|source)[^>]+src=["'](https?:[^"']+)["']/gi)) found.push(m[1]);
  const vids = found.map(abs).filter((x) => x && /^https?:/.test(x) && !/\.m3u8(\?|$)/i.test(x));
  if (vids.length) return vids[0];
  const img = meta('og:image:secure_url') || meta('og:image') || meta('twitter:image');
  return img ? abs(img) : null;
}
async function ipcMainFetchDropped(url, depth = 0) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'bad-url' };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30000);
    try {
      const r = await enet.fetch(u.href, { signal: ac.signal, headers: { Accept: 'image/*,video/*;q=0.9,text/html;q=0.8,*/*;q=0.5', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' } });
      if (!r.ok) return { error: 'http ' + r.status };
      const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (mime === 'text/html' && depth === 0) {
        const html = (await r.text()).slice(0, 4 * 1024 * 1024);
        const media = mediaFromPage(html, u.href);
        log('drop-fetch', { page: u.hostname, found: media ? new URL(media).pathname.split('.').pop() : null });
        if (!media) return { error: 'not-media' };
        clearTimeout(t);
        return await ipcMainFetchDropped(media, 1);
      }
      if (!/^(image|video)\//.test(mime)) return { error: 'not-media' };
      if (Number(r.headers.get('content-length')) > DROP_MAX) return { error: 'too-big' };
      const chunks = []; let size = 0;
      for await (const c of r.body) {
        size += c.length;
        if (size > DROP_MAX) { ac.abort(); return { error: 'too-big' }; }
        chunks.push(c);
      }
      const name = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      return { bytes: Buffer.concat(chunks), mime, name };
    } finally { clearTimeout(t); }
  } catch (e) {
    log('drop-fetch', { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 80) });
    return { error: 'fail' };
  }
}
ipcMain.handle('fetch-dropped', (_e, url) => ipcMainFetchDropped(url, 0));
/* =========================================================
   Стикеры (1.21): свои наборы картинок и гифок. Папка userData/stickers/<набор>/<id>.<ext>, список — stickers.json.
   Добавить: файлы или папку (каждая подпапка с картинками — свой набор, имя — имя папки).
   Формат определяется по содержимому (gif/png/jpg/webp), до 3 МБ на стикер, не больше 6000 всего.
   ========================================================= */
const STK_MAX = 3 * 1024 * 1024;
const STK_TOTAL = 6000;
function stkDir() { return path.join(app.getPath('userData'), 'stickers'); }
function stkIndex() { return path.join(stkDir(), 'stickers.json'); }
function stkRead() { try { const d = JSON.parse(fs.readFileSync(stkIndex(), 'utf-8')); return { packs: Array.isArray(d.packs) ? d.packs : [] }; } catch { return { packs: [] }; } }
function stkWrite(d) { fs.mkdirSync(stkDir(), { recursive: true }); fs.writeFileSync(stkIndex() + '.tmp', JSON.stringify(d)); fs.renameSync(stkIndex() + '.tmp', stkIndex()); }
const stkId = () => require('crypto').randomBytes(5).toString('hex');
function stkSniff(b) {
  if (b.length < 12) return null;
  const s = (i, n) => b.toString('latin1', i, i + n);
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return ['image/gif', 'gif'];
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return ['image/png', 'png'];
  if (b[0] === 0xff && b[1] === 0xd8) return ['image/jpeg', 'jpg'];
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return ['image/webp', 'webp'];
  return null;
}
// добавить файлы в набор (новый или существующий по имени); возвращает сколько добавлено/пропущено
function stkAddFiles(d, packName, files) {
  let pack = d.packs.find((p) => p.name === packName);
  if (!pack) { pack = { id: stkId(), name: String(packName).slice(0, 40) || 'Стикеры', items: [] }; d.packs.push(pack); }
  fs.mkdirSync(path.join(stkDir(), pack.id), { recursive: true });
  const total = () => d.packs.reduce((n, p) => n + p.items.length, 0);
  let added = 0, skipped = 0;
  for (const f of files) {
    try {
      if (total() >= STK_TOTAL) { skipped++; continue; }
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > STK_MAX || st.size < 12) { skipped++; continue; }
      const buf = fs.readFileSync(f);
      const kind = stkSniff(buf);
      if (!kind) { skipped++; continue; }
      const id = stkId();
      fs.writeFileSync(path.join(stkDir(), pack.id, `${id}.${kind[1]}`), buf);
      pack.items.push({ id, mime: kind[0], ext: kind[1], name: path.basename(f).replace(/\.[^.]+$/, '').slice(0, 40) });
      added++;
    } catch { skipped++; }
  }
  if (!pack.items.length) d.packs = d.packs.filter((p) => p !== pack);
  return { added, skipped };
}
// папка: картинки в каждой подпапке — отдельный набор (до 4 уровней), имя набора — имя папки
function stkWalk(dir, depth, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const files = ents.filter((e) => e.isFile()).map((e) => path.join(dir, e.name)).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  if (files.length) out.push({ name: path.basename(dir), files });
  if (depth < 4) for (const e of ents) if (e.isDirectory()) stkWalk(path.join(dir, e.name), depth + 1, out);
}
ipcMain.handle('stickers-list', () => stkRead());
ipcMain.handle('stickers-get', (_e, packId, id) => {
  const d = stkRead();
  const p = d.packs.find((x) => x.id === packId);
  const it = p?.items.find((x) => x.id === id);
  if (!it || !/^[a-f0-9]{10}$/.test(p.id) || !/^[a-f0-9]{10}$/.test(it.id)) return null;
  try { return { bytes: fs.readFileSync(path.join(stkDir(), p.id, `${it.id}.${it.ext}`)), mime: it.mime }; } catch { return null; }
});
ipcMain.handle('stickers-pick', async (_e, mode) => {
  // ALOCALLS_STK_PICK — только для автотеста: путь вместо окна выбора
  const r = process.env.ALOCALLS_STK_PICK ? { canceled: false, filePaths: [process.env.ALOCALLS_STK_PICK] } : await dialog.showOpenDialog(win, mode === 'folder'
    ? { title: 'Папка со стикерами', properties: ['openDirectory'] }
    : { title: 'Стикеры — картинки и гифки', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Картинки и гифки', extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const d = stkRead();
  let added = 0, skipped = 0, packs = 0;
  if (mode === 'folder') {
    const groups = [];
    stkWalk(r.filePaths[0], 0, groups);
    for (const g of groups) { const x = stkAddFiles(d, g.name, g.files); added += x.added; skipped += x.skipped; if (x.added) packs++; }
  } else {
    const x = stkAddFiles(d, 'Мои стикеры', r.filePaths);
    added = x.added; skipped = x.skipped; packs = x.added ? 1 : 0;
  }
  stkWrite(d);
  log('stickers', { import: mode, added, skipped, packs });
  return { added, skipped, packs };
});
// стикер из чата — в набор «Полученные»
ipcMain.handle('stickers-add-bytes', (_e, bytes, name) => {
  const buf = Buffer.from(bytes);
  if (buf.length > STK_MAX || !stkSniff(buf)) return false;
  const tmp = path.join(app.getPath('temp'), `alc-stk-${stkId()}`);
  fs.writeFileSync(tmp, buf);
  const d = stkRead();
  const x = stkAddFiles(d, 'Полученные', [tmp]);
  try { fs.unlinkSync(tmp); } catch { /* */ }
  if (x.added) { const p = d.packs.find((q) => q.name === 'Полученные'); const it = p?.items[p.items.length - 1]; if (it && name) it.name = String(name).slice(0, 40); }
  stkWrite(d);
  return x.added > 0;
});
ipcMain.handle('stickers-del-pack', (_e, id) => {
  const d = stkRead();
  if (!/^[a-f0-9]{10}$/.test(String(id))) return false;
  d.packs = d.packs.filter((p) => p.id !== id);
  stkWrite(d);
  try { fs.rmSync(path.join(stkDir(), id), { recursive: true, force: true }); } catch { /* */ }
  return true;
});
ipcMain.handle('stickers-del', (_e, packId, id) => {
  const d = stkRead();
  const p = d.packs.find((x) => x.id === packId);
  const it = p?.items.find((x) => x.id === id);
  if (!it) return false;
  p.items = p.items.filter((x) => x !== it);
  if (!p.items.length) d.packs = d.packs.filter((x) => x !== p);
  stkWrite(d);
  try { fs.unlinkSync(path.join(stkDir(), p.id, `${it.id}.${it.ext}`)); } catch { /* */ }
  return true;
});

/* =========================================================
   «Убрать фон» нейросетью (1.22): MODNet — человек, IS-Net — любой предмет. Движок onnxruntime (Windows x64, DirectML →
   процессор) и модели скачиваются один раз по требованию из служебного релиза этого репозитория (models-v1),
   с проверкой SHA-256, в userData/ai. В app.asar их нет: автообновление меняет только app.asar.
   ai-mask: RGBA кадра → маска (0–255) того же размера. Кадры гифки приходят по одному из окна.
   ========================================================= */
const AI_BASE = process.env.ALOCALLS_AI_BASE || `https://github.com/${GH_REPO}/releases/download/models-v1`;
const AI_FILES = {
  runtime: { n: 'ort-win-x64-1.31.1.tar.gz', sha: '8b0d6f34161adb47d1c469f629cde715dd4370305565e5f048cae80566e17d8a', size: 29073316 },
  person: { n: 'modnet.onnx', sha: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9', size: 25888640 },
  object: { n: 'isnet-general-use.onnx', sha: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a', size: 178648008 },
};
// как готовить вход: размер (MODNet — кратно 32 по короткой стороне 512, IS-Net — ровно 1024) и нормировка
const AI_MODEL = { person: { mean: 0.5, std: 0.5, size: 512, keep: true }, object: { mean: 0.5, std: 1, size: 1024, keep: false } };
const aiDir = () => path.join(app.getPath('userData'), 'ai');
const AI = { ort: null, sess: {}, busy: Promise.resolve(), ep: null };

function aiHave(kind) {
  const f = AI_FILES[kind];
  if (kind === 'runtime') return fs.existsSync(path.join(aiDir(), 'runtime', 'onnxruntime-node', 'package.json')) && fs.existsSync(path.join(aiDir(), 'runtime', '.ok-' + f.sha.slice(0, 16)));
  try { return fs.statSync(path.join(aiDir(), f.n)).size === f.size && fs.existsSync(path.join(aiDir(), '.ok-' + f.sha.slice(0, 16))); } catch { return false; }
}
// обрыв на большом файле — не повод сдаваться: до трёх попыток
async function aiDownload(kind, progress) {
  let err = null;
  for (let i = 0; i < 3; i++) {
    try { return await aiDownloadOnce(kind, progress); } catch (e) { err = e; log('ai', { retry: kind, n: i + 1, error: String(e.message).slice(0, 80) }); if (/повреждён|больше ожидаемого/.test(e.message)) break; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw err;
}
async function aiDownloadOnce(kind, progress) {
  const f = AI_FILES[kind];
  fs.mkdirSync(aiDir(), { recursive: true });
  const out = path.join(aiDir(), f.n);
  const part = out + '.part';
  const r = await enet.fetch(`${AI_BASE}/${f.n}`, { headers: { 'User-Agent': 'alloconnect' } });
  if (!r.ok) throw new Error('не скачалось: ' + r.status);
  const h = require('crypto').createHash('sha256');
  const ws = fs.createWriteStream(part);
  let got = 0, last = 0;
  try {
    for await (const c of r.body) {
      got += c.length;
      if (got > f.size) throw new Error('файл больше ожидаемого');
      h.update(c);
      if (!ws.write(c)) await new Promise((res) => ws.once('drain', res));
      if (Date.now() - last > 250) { last = Date.now(); progress?.(kind, got, f.size); }
    }
  } finally { await new Promise((res) => ws.end(res)); }
  if (got !== f.size || h.digest('hex') !== f.sha) { try { fs.unlinkSync(part); } catch { /* */ } throw new Error('файл повреждён (контрольная сумма не совпала)'); }
  fs.renameSync(part, out);
  progress?.(kind, f.size, f.size);
  if (kind === 'runtime') {
    const dir = path.join(aiDir(), 'runtime');
    fs.rmSync(dir, { recursive: true, force: true });
    aiUntar(require('zlib').gunzipSync(fs.readFileSync(out)), dir);
    fs.unlinkSync(out);
    fs.writeFileSync(path.join(dir, '.ok-' + f.sha.slice(0, 16)), '');
  } else fs.writeFileSync(path.join(aiDir(), '.ok-' + f.sha.slice(0, 16)), '');
  log('ai', { downloaded: kind, mb: Math.round(f.size / 1048576) });
}
// tar (ustar) → папка; только обычные файлы и папки внутри dir
function aiUntar(buf, dir) {
  for (let off = 0; off + 512 <= buf.length;) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, n) => hdr.toString('utf8', a, a + n).replace(/\0.*$/s, '');
    const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const dest = path.resolve(dir, name);
    if (!dest.startsWith(path.resolve(dir) + path.sep)) throw new Error('плохой путь в архиве');
    if (type === '5') fs.mkdirSync(dest, { recursive: true });
    else if (type === '0' || type === '\0') { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf.subarray(off + 512, off + 512 + size)); }
    off += 512 + Math.ceil(size / 512) * 512;
  }
}
async function aiSession(kind) {
  if (AI.sess[kind]) return AI.sess[kind];
  if (!AI.ort) AI.ort = require(path.join(aiDir(), 'runtime', 'onnxruntime-node'));
  const file = path.join(aiDir(), AI_FILES[kind].n);
  for (const ep of AI.ep ? [AI.ep] : ['dml', 'cpu']) {
    try {
      AI.sess[kind] = await AI.ort.InferenceSession.create(file, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      AI.ep = ep;
      log('ai', { session: kind, ep });
      return AI.sess[kind];
    } catch (e) { log('ai', { sessionFailed: kind, ep, error: String(e.message).slice(0, 120) }); }
  }
  throw new Error('нейросеть не запустилась');
}
// билинейное масштабирование одного канала (Float32) / RGBA → CHW с нормировкой
function aiInput(rgba, w, h, W, H, mean, std) {
  const out = new Float32Array(3 * W * H);
  const sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), dy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), dx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = rgba[(y0 * w + x0) * 4 + c], b = rgba[(y0 * w + x1) * 4 + c], cc = rgba[(y1 * w + x0) * 4 + c], d = rgba[(y1 * w + x1) * 4 + c];
        const v = (a * (1 - dx) + b * dx) * (1 - dy) + (cc * (1 - dx) + d * dx) * dy;
        out[c * W * H + y * W + x] = (v / 255 - mean) / std;
      }
    }
  }
  return out;
}
// sharp — IS-Net даёт мягкую маску (всё полупрозрачное): поднимаем контраст, уверенное — плотное, сомнительное — прочь
function aiMaskBack(m, W, H, w, h, sharp) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < m.length; i++) { if (m[i] < lo) lo = m[i]; if (m[i] > hi) hi = m[i]; }
  const k = hi - lo > 1e-6 ? 1 / (hi - lo) : 1;
  const out = new Uint8Array(w * h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(H - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), dy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), dx = fx - x0;
      const v = (m[y0 * W + x0] * (1 - dx) + m[y0 * W + x1] * dx) * (1 - dy) + (m[y1 * W + x0] * (1 - dx) + m[y1 * W + x1] * dx) * dy;
      let t = (v - lo) * k;
      if (sharp) { t = Math.max(0, Math.min(1, (t - 0.25) / 0.4)); t = t * t * (3 - 2 * t); }
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(t * 255)));
    }
  }
  return out;
}
ipcMain.handle('ai-status', () => ({ runtime: aiHave('runtime'), person: aiHave('person'), object: aiHave('object'), sizes: { runtime: AI_FILES.runtime.size, person: AI_FILES.person.size, object: AI_FILES.object.size } }));
ipcMain.handle('ai-prepare', async (e, kind) => {
  if (!AI_MODEL[kind]) return { ok: false, error: 'нет такой модели' };
  if (process.platform !== 'win32' || process.arch !== 'x64') return { ok: false, error: 'нейросеть есть только для Windows x64' };
  const progress = (k, got, total) => { try { e.sender.send('ai-progress', { kind: k, got, total }); } catch { /* */ } };
  try {
    if (!aiHave('runtime')) await aiDownload('runtime', progress);
    if (!aiHave(kind)) await aiDownload(kind, progress);
    await aiSession(kind);
    return { ok: true, ep: AI.ep };
  } catch (err) { log('ai', { prepareFailed: kind, error: String(err.message).slice(0, 120) }); return { ok: false, error: err.message }; }
});
ipcMain.handle('ai-mask', (_e, kind, rgba, w, h) => {
  // по одному кадру за раз — нейросеть не любит параллельных запусков
  const job = AI.busy.then(async () => {
    const cfg = AI_MODEL[kind];
    if (!cfg || !(w > 0 && h > 0 && w * h * 4 === rgba.length)) throw new Error('плохой кадр');
    const s = await aiSession(kind);
    let W = cfg.size, H = cfg.size;
    if (cfg.keep) { // MODNet: короткая сторона 512, обе — кратно 32
      const k = cfg.size / Math.min(w, h);
      W = Math.max(32, Math.round((w * k) / 32) * 32); H = Math.max(32, Math.round((h * k) / 32) * 32);
    }
    const x = new AI.ort.Tensor('float32', aiInput(rgba, w, h, W, H, cfg.mean, cfg.std), [1, 3, H, W]);
    const out = await s.run({ [s.inputNames[0]]: x });
    const t = out[s.outputNames[0]];
    const [oh, ow] = t.dims.slice(-2);
    return aiMaskBack(t.data, ow, oh, w, h, kind === 'object');
  });
  AI.busy = job.catch(() => {});
  return job;
});

async function ghCheck() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(GH_REPO)) return { ok: false, error: 'no-repo' };
  // 1) ветка updates в репозитории: update.json + файлы рядом; 2) запасной путь — раздел релизов
  let u, fileUrl, page = `https://github.com/${GH_REPO}`;
  try {
    u = JSON.parse((await ghGet(`${GH_RAW}/${GH_REPO}/updates/update.json?t=${Date.now()}`, false)).toString('utf-8'));
    fileUrl = (n) => `${GH_RAW}/${GH_REPO}/updates/${n}?t=${Date.now()}`;
  } catch (e) {
    if (!/пока нет/.test(e.message)) throw e;
    const rel = await ghGet(`${GH_API}/repos/${GH_REPO}/releases/latest`, true);
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const asset = (n) => assets.find((a) => a && a.name === n);
    if (/^https:\/\/github\.com\//.test(String(rel.html_url))) page = String(rel.html_url);
    const uj = asset('update.json');
    if (!uj) return { ok: false, error: 'в релизе нет update.json', page };
    u = JSON.parse((await ghGet(uj.browser_download_url, false)).toString('utf-8'));
    fileUrl = (n) => asset(n)?.browser_download_url;
  }
  const c = checkManifest(u.m, u.sig);
  if (!c.ok) { log('update', { gh: 'rejected', why: c.error }); return { ok: false, error: c.error, page }; }
  const v = c.man.v;
  if (verCmp(v, app.getVersion()) <= 0) return { ok: true, none: true, v };
  if (c.man.electron !== process.versions.electron) return { ok: true, manual: true, v, page };
  if (!app.isPackaged && !FAKE_HELPER) return { ok: true, manual: true, v, page };
  if (staged && staged.man.v === v && staged.got.size === UPDATE_FILES.length) return { ok: true, ready: true, v, notes: String(c.man.notes || '').slice(0, 300) };
  const dir = path.join(stagingDir(), v);
  try { fs.rmSync(stagingDir(), { recursive: true, force: true }); } catch { /* */ }
  fs.mkdirSync(dir, { recursive: true });
  staged = { man: c.man, m: u.m, sig: u.sig, dir, got: new Set() };
  log('update', { gh: 'download', v });
  for (const f of c.man.files) {
    const url = fileUrl(f.n);
    if (!url) { staged = null; return { ok: false, error: 'нет файла ' + f.n, page }; }
    const buf = await ghGet(url, false);
    const hash = crypto2.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== f.size || hash !== f.sha256) { staged = null; log('update', { gh: 'badFile', n: f.n }); return { ok: false, error: 'файл повреждён', page }; }
    ofs.writeFileSync(path.join(dir, f.n), buf);
    staged.got.add(f.n);
  }
  fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ m: u.m, sig: u.sig }));
  log('update', { gh: 'ready', v });
  return { ok: true, ready: true, v, notes: String(c.man.notes || '').slice(0, 300) };
}
ipcMain.handle('gh-check', async () => {
  if (!ghBusy) ghBusy = ghCheck().catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 120) })).finally(() => { ghBusy = null; });
  return ghBusy;
});
ipcMain.handle('gh-repo', () => (/^[\w.-]+\/[\w.-]+$/.test(GH_REPO) ? GH_REPO : ''));
ipcMain.handle('upd-staged', () => (staged && staged.got.size === UPDATE_FILES.length ? { v: staged.man.v, notes: String(staged.man.notes || '').slice(0, 300) } : null));
// перезапуск с установкой: помощник ждёт выхода, подменяет файлы и запускает alloconnect снова
ipcMain.handle('upd-apply', () => {
  if (!staged || staged.got.size !== UPDATE_FILES.length) return { ok: false, error: 'обновление не готово' };
  if (!app.isPackaged && !FAKE_HELPER) return { ok: false, error: 'только в собранной программе' };
  for (const f of staged.man.files) { if (sha256File(path.join(staged.dir, f.n)) !== f.sha256) return { ok: false, error: 'файл повреждён' }; }
  const runner = path.join(stagingDir(), 'apply.exe');
  fs.copyFileSync(helperPath(), runner); // запускаем копию текущего помощника — сам он будет заменён
  const args = ['apply', path.join(stagingDir(), 'result.txt'), String(process.pid), process.execPath];
  for (const n of UPDATE_FILES) args.push(path.join(staged.dir, n), path.join(resDir(), n));
  fs.writeFileSync(path.join(stagingDir(), 'pending.json'), JSON.stringify({ from: app.getVersion(), to: staged.man.v }));
  log('update', { apply: staged.man.v });
  if (FAKE_HELPER) spawn(process.execPath, [FAKE_HELPER, ...args], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
  else spawn(runner, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => { appQuitting = true; app.quit(); }, 300);
  return { ok: true };
});
// откат на прошлую версию (файлы *.old рядом)
ipcMain.handle('upd-backup', () => UPDATE_FILES.every((n) => fs.existsSync(path.join(resDir(), n + '.old'))));
ipcMain.handle('upd-rollback', () => {
  if (!UPDATE_FILES.every((n) => fs.existsSync(path.join(resDir(), n + '.old')))) return { ok: false, error: 'нет прошлой версии' };
  if (!app.isPackaged && !FAKE_HELPER) return { ok: false, error: 'только в собранной программе' };
  fs.mkdirSync(stagingDir(), { recursive: true });
  const runner = path.join(stagingDir(), 'apply.exe');
  fs.copyFileSync(helperPath(), runner);
  const args = ['swap', path.join(stagingDir(), 'result.txt'), String(process.pid), process.execPath, ...UPDATE_FILES.map((n) => path.join(resDir(), n))];
  fs.writeFileSync(path.join(stagingDir(), 'pending.json'), JSON.stringify({ from: app.getVersion(), to: 'rollback' }));
  log('update', { rollback: true });
  if (FAKE_HELPER) spawn(process.execPath, [FAKE_HELPER, ...args], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
  else spawn(runner, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => { appQuitting = true; app.quit(); }, 300);
  return { ok: true };
});
// после перезапуска: чем закончилась установка
let updResult = null;
function checkUpdateResult() {
  try {
    const pend = JSON.parse(fs.readFileSync(path.join(stagingDir(), 'pending.json'), 'utf-8'));
    let res = 'unknown';
    try { res = fs.readFileSync(path.join(stagingDir(), 'result.txt'), 'utf-8').trim(); } catch { /* */ }
    updResult = { ok: res === 'ok', err: res === 'ok' ? null : res, from: pend.from, to: pend.to, now: app.getVersion() };
    log('update', { result: updResult });
    // поставилась — кладём её подписанный update.json к программе: теперь и мы можем раздать её друзьям
    // (помощник меняет только app.asar и exe; подпись и версию проверит loadOwnUpdate)
    if (updResult.ok && pend.to === app.getVersion()) {
      try { fs.copyFileSync(path.join(stagingDir(), pend.to, 'update.json'), path.join(resDir(), 'update.json')); } catch (e) { log('update', { manifestCopy: e.message }); }
    }
    fs.rmSync(stagingDir(), { recursive: true, force: true });
  } catch { /* обновления не было */ }
}
ipcMain.handle('upd-result', () => { const r = updResult; updResult = null; return r; });
app.whenReady().then(() => { if (!firstInstance) return; checkUpdateResult(); loadOwnUpdate(); });
