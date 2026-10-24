const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('./main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE = process.env.ROLE, SH = process.env.SHARED;
const flag = (n) => fs.writeFileSync(`${SH}/${ROLE}_${n}`, '1');
const waitFlag = async (n, t = 60000) => { const o = ROLE === 'A' ? 'B' : 'A'; const t0 = Date.now(); while (Date.now() - t0 < t) { if (fs.existsSync(`${SH}/${o}_${n}`)) return true; await sleep(150); } return false; };
const res = {};
app.whenReady().then(async () => {
  await sleep(3000);
  const W = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'alloconnect-overlay');
  const js = (c) => W.webContents.executeJavaScript(c);
  const errs = []; W.webContents.on('console-message', (e) => { const l = e.level ?? e.params?.level; if (l === 'error') errs.push(e.message ?? e.params?.message); });
  const waitFor = async (expr, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await js(expr)) return true; } catch { } await sleep(200); } return false; };
  const C = `convs.get(friendsList[0].id)`;
  const byText = (t) => `[...${C}.msgs.values()].find(x => x.e.text === ${JSON.stringify(t)})`;
  try {
    await waitFor(`friendsList[0] && friendsList[0].online && friendsList[0].ver`, 30000);
    await js(`window.duo.histClear(friendsList[0].id).then(() => { convs.clear(); true })`).catch(() => {});
    await js(`(async () => { for (const c of convs.values()) c.box.replaceChildren(); convs.clear(); return true })()`);
    flag('ready'); await waitFlag('ready');
    await js(`openDm(friendsList[0].id)`);
    await sleep(500);
    if (ROLE === 'A') {
      // 1) текст без звонка
      await js(`document.getElementById('dmInput').value = 'первое сообщение'; dmSendText()`);
      flag('sent1');
      // 3) реакция друга видна
      await waitFlag('reacted');
      res.reactSeen = await waitFor(`(() => { const it = ${byText('первое сообщение')}; const c = it && it.el.querySelector('.react-chip'); return c && c.textContent === '👍' && it.e.react.peer === '👍'; })()`);
      // 4) ответ друга с цитатой
      await waitFlag('replied');
      res.quoteSeen = await waitFor(`(() => { const it = ${byText('ответ на первое')}; const q = it && it.el.querySelector('.quote'); return q && q.textContent.includes('первое сообщение') && it.e.re.by === 'me'; })()`);
      // клик по цитате прокручивает к оригиналу
      res.quoteJump = await js(`(() => { const it = ${byText('ответ на первое')}; it.el.querySelector('.quote').click(); return ${byText('первое сообщение')}.el.classList.contains('flash'); })()`);
      // 5) правка своего: стрелка вверх → режим правки → Enter
      await js(`(() => { const i = document.getElementById('dmInput'); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); return true; })()`);
      res.arrowUpEdit = await js(`composers.dm.mode === 'edit' && document.getElementById('dmInput').value === 'первое сообщение' && !document.querySelector('#dm .compose-bar').classList.contains('hidden')`);
      await js(`document.getElementById('dmInput').value = 'первое сообщение (испр.)'; dmSendText()`);
      await sleep(400);
      res.editLocal = await js(`(() => { const it = [...${C}.msgs.values()].find(x => x.e.text === 'первое сообщение (испр.)'); return !!it && !!it.el.querySelector('.meta .edited') && it.el.querySelector('.btext').textContent === 'первое сообщение (испр.)'; })()`);
      flag('edited');
      // 6) второе сообщение и удаление
      await js(`document.getElementById('dmInput').value = 'удали меня'; dmSendText()`);
      await sleep(600);
      flag('sent2');
      await waitFlag('seen2');
      await js(`(() => { const it = ${byText('удали меня')}; return sendMsgOp(${C}, { op: 'del', ref: it.e.mid }); })()`);
      await sleep(400);
      res.delLocal = await js(`[...${C}.msgs.values()].some(x => x.e.deleted && x.el.textContent.includes('Сообщение удалено'))`);
      flag('deleted');
      // 7) подделка: друг пытается изменить моё сообщение — игнор
      await waitFlag('forged');
      await sleep(600);
      res.forgedIgnored = await js(`!![...${C}.msgs.values()].find(x => x.e.text === 'первое сообщение (испр.)')`);
      // 8) кнопки при наведении
      res.hoverPeer = await js(`(() => { const it = ${byText('ответ на первое')}; it.el.querySelector('.bubble').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const b = document.getElementById('msgActs'); return { shown: !b.classList.contains('hidden'), edit: !b.querySelector('[data-a=edit]').classList.contains('hidden'), del: !b.querySelector('[data-a=del]').classList.contains('hidden') }; })()`);
      res.hoverMine = await js(`(() => { const it = [...${C}.msgs.values()].find(x => x.e.text === 'первое сообщение (испр.)'); it.el.querySelector('.bubble').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const b = document.getElementById('msgActs'); return { shown: !b.classList.contains('hidden'), edit: !b.querySelector('[data-a=edit]').classList.contains('hidden'), del: !b.querySelector('[data-a=del]').classList.contains('hidden') }; })()`);
      // реакция кнопкой из всплывашки на сообщение друга
      await js(`(() => { const it = ${byText('ответ на первое')}; it.el.querySelector('.bubble').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('#msgActs [data-r="😂"]').click(); return true; })()`);
      await sleep(500);
      res.myReactViaBar = await js(`${byText('ответ на первое')}.e.react.me === '😂'`);
      // ответ кнопкой ↩ из всплывашки
      await js(`(() => { const it = ${byText('ответ на первое')}; it.el.querySelector('.bubble').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('#msgActs [data-a=reply]').click(); return true; })()`);
      res.replyBar = await js(`composers.dm.mode === 'reply' && document.querySelector('#dm .compose-bar small').textContent`);
      await js(`(() => { const i = document.getElementById('dmInput'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
      res.escCancels = await js(`composers.dm.mode === null && document.querySelector('#dm .compose-bar').classList.contains('hidden')`);
      await sleep(800);
      // 9) история: перечитать с диска
      await js(`(() => { const id = friendsList[0].id; closeDm(); convs.delete(id); return openDm(id); })()`);
      await sleep(800);
      res.history = await js(`(() => { const v = [...${C}.msgs.values()]; const f = (t) => v.find(x => x.e.text === t); return {
        edited: !!f('первое сообщение (испр.)') && !!f('первое сообщение (испр.)').el.querySelector('.edited'),
        reactPeer: f('первое сообщение (испр.)')?.e.react?.peer,
        quote: !!f('ответ на первое')?.el.querySelector('.quote'),
        myReact: f('ответ на первое')?.e.react?.me,
        deleted: v.filter(x => x.e.deleted).length,
        noDeletedText: !document.getElementById('dmMessages').textContent.includes('удали меня'),
      }; })()`);
      // 10) поиск
      await js(`toggleSearch('dm'); const i = document.querySelector('.msg-search input'); i.value = 'ответ'; i.dispatchEvent(new Event('input')); true`);
      await sleep(700);
      res.search = await js(`[...document.querySelectorAll('.ms-row')].map(r => r.textContent)`);
      res.searchDeletedHidden = await js(`(async () => (await window.duo.histSearch(friendsList[0].id, 'удали')).length === 0)()`);
      await js(`document.querySelector('.ms-row').click(); true`);
      await sleep(600);
      res.searchJump = await js(`document.querySelector('.msg-search').classList.contains('hidden') && ${byText('ответ на первое')}.el.classList.contains('flash')`);
      fs.writeFileSync(`${SH}/A_chat.png`, (await W.webContents.capturePage()).toPNG());
      flag('done-dm');
      // 11) в звонке
      await js(`closeDm(); callFriend(friendsList[0].id); true`);
      res.connected = await waitFor(`S.connected && S.friendPerm && S.friendPerm.ops`, 40000);
      await sleep(800);
      await js(`document.getElementById('chatInput').value = 'в звонке'; document.getElementById('chatForm').requestSubmit(); true`);
      flag('callmsg');
      await waitFlag('callreact', 30000);
      res.callReact = await waitFor(`(() => { const it = [...S.callConv.msgs.values()].find(x => x.e.text === 'в звонке'); return it && it.e.react.peer === '🔥' && !!it.el.querySelector('.react-chip'); })()`);
      fs.writeFileSync(`${SH}/A_call.png`, (await W.webContents.capturePage()).toPNG());
      // меню при наведении в чате звонка
      res.callHover = await js(`(() => { const it = [...S.callConv.msgs.values()].find(x => x.e.text === 'в звонке'); it.el.querySelector('.bubble').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const b = document.getElementById('msgActs'); return !b.classList.contains('hidden') && !b.querySelector('[data-a=edit]').classList.contains('hidden'); })()`);
      fs.writeFileSync(`${SH}/A_hover.png`, (await W.webContents.capturePage()).toPNG());
    } else {
      await waitFlag('sent1');
      res.got1 = await waitFor(`!!${byText('первое сообщение')}`);
      await js(`sendMsgOp(${C}, { op: 'react', ref: ${byText('первое сообщение')}.e.mid, e: '👍' })`);
      res.reactChipLocal = await js(`${byText('первое сообщение')}.el.querySelector('.react-chip.mine')?.textContent`);
      flag('reacted');
      await js(`setCompose(composers.dm, 'reply', ${byText('первое сообщение')}); document.getElementById('dmInput').value = 'ответ на первое'; dmSendText()`);
      await sleep(400);
      res.myQuote = await js(`!!${byText('ответ на первое')}.el.querySelector('.quote')`);
      flag('replied');
      await waitFlag('edited');
      res.editSeen = await waitFor(`(() => { const it = [...${C}.msgs.values()].find(x => x.e.text === 'первое сообщение (испр.)'); return it && !!it.el.querySelector('.edited') && it.el.querySelector('.react-chip')?.textContent === '👍'; })()`);
      await waitFlag('sent2');
      await waitFor(`!!${byText('удали меня')}`);
      flag('seen2');
      await waitFlag('deleted');
      res.delSeen = await waitFor(`[...${C}.msgs.values()].some(x => x.e.deleted && x.el.textContent.includes('Сообщение удалено')) && !document.getElementById('dmMessages').textContent.includes('удали меня')`);
      // подделка: пытаюсь изменить чужое сообщение напрямую
      await js(`window.duo.friendsSend(friendsList[0].id, { t: 'dm-op', op: 'edit', ref: [...${C}.msgs.values()].find(x => x.e.text === 'первое сообщение (испр.)').e.mid, text: 'взлом', ts: Date.now() })`);
      flag('forged');
      res.myReactSeen = await waitFor(`${byText('ответ на первое')}.e.react.me === undefined && ${byText('ответ на первое')}.e.react.peer === '😂'`, 20000);
      await waitFlag('done-dm', 60000);
      await js(`closeDm(); true`);
      await waitFor(`!document.getElementById('callModal').classList.contains('hidden')`, 30000);
      await sleep(400);
      await js(`document.getElementById('btnCallAccept').click(); true`);
      res.connected = await waitFor(`S.connected`, 40000);
      await waitFlag('callmsg', 30000);
      await waitFor(`!![...S.callConv.msgs.values()].find(x => x.e.text === 'в звонке')`);
      await js(`(() => { const it = [...S.callConv.msgs.values()].find(x => x.e.text === 'в звонке'); it.el.querySelector('.bubble').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('#msgActs [data-r="🔥"]').click(); return true; })()`);
      flag('callreact');
    }
    await sleep(1500);
    flag('done'); await waitFlag('done', 60000);
  } catch (e) { res.exception = String(e.stack || e); }
  res.errors = errs.slice(0, 5);
  console.log(ROLE, 'RESULT', JSON.stringify(res, null, 1));
  app.exit(0);
});
