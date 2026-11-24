'use strict';
(()=>{
 const lab=window.accountLab,e=lab.engine,recovery=window.accountRecovery;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const entry=document.createElement('button');entry.id='account-lab-entry';entry.type='button';entry.className='btn';entry.textContent='Аккаунт и устройства';
 const row=document.createElement('div');row.className='account-settings-row';
 const hint=document.createElement('small');hint.className='muted';hint.textContent='Общий профиль и связанные устройства';row.append(entry,hint);
 const settingsRoot=document.getElementById('settings');
 if(lab.platform==='desktop')settingsRoot.querySelector('.modal-head').after(row);else settingsRoot.querySelector('.scroll').prepend(row);
 const panel=document.createElement('section');panel.id='account-lab';panel.setAttribute('aria-label','Общий аккаунт AlloConnect');
 panel.hidden=true;
 panel.innerHTML='<div class="lab-shell"><div class="lab-header"><div><strong>Общий аккаунт AlloConnect</strong><div class="lab-tag">Синхронизация устройств · бета</div></div><button id="lab-hide">Назад к настройкам</button></div><p id="lab-error" class="lab-error" role="alert"></p><div id="lab-view"></div></div>';document.body.append(panel);
 const $=id=>document.getElementById(id);let pending=[],lastKey='',busy=false;
 function bind(id,fn){const el=$(id);if(el)el.onclick=()=>action(fn)}
 async function action(fn){if(busy)return;busy=true;try{e.error='';await fn()}catch(err){e.fail(err)}finally{busy=false;render()}}
 function autoPropose(){if(e.s?.phase!=='choices'||e.s.role!=='host')return;if(busy){setTimeout(autoPropose,100);return}action(()=>e.propose({contacts:{}}))}
 function avatarHtml(p){return p.avatar?`<img class="lab-avatar" src="data:${esc(p.avatar.mime)};base64,${esc(p.avatar.b64)}" alt="Аватар">`:''}
 function profileCard(p,title,value){return `<label class="lab-card">${avatarHtml(p)}<h3>${esc(title)}</h3><p>${esc(p.nick)}</p><input type="radio" name="lab-profile" value="${value}">Использовать эти имя и аватар</label>`}
 const note='<p class="lab-note lab-small">Профиль, контакты, переписка, вложения и журнал звонков общие. Изменения без связи сохраняются и передаются при подключении. Настройки ПК передаются только другим ПК, настройки телефона — только телефонам. На телефоне обмен продолжается при включённой настройке «Быть в сети в фоне». На ПК приложение должно оставаться запущенным.</p>';
 function render(){
  const errorNode=$('lab-error'),newError=errorNode.textContent!==e.error;errorNode.textContent=e.error;if(e.error&&newError&&!panel.hidden)requestAnimationFrame(()=>errorNode.scrollIntoView({block:'nearest'}));const status=$('lab-sync-status');if(status)status.textContent=lab.sync.status.text;const s=e.s;
  const unlinkPending=recovery.unlinkPending();
  const key=JSON.stringify({phase:s?.phase,peer:s?.peer,phrase:s?.phrase,lv:s?.localVerified,rv:s?.remoteVerified,la:s?.localApproved,ra:s?.remoteApproved,digest:s?.digest,conflicts:e.getConflicts(),pending,account:e.account,unlinkPending});if(key===lastKey)return;lastKey=key;
  let h='';
  if(unlinkPending)h='<h2>Отвязка устройства</h2><button id="lab-unlink">Продолжить отвязку</button>';
  else if(!s){const account=e.account;h=`<h2>Мои устройства</h2><p class="lab-muted">Один аккаунт. Независимые ПК и телефон.</p>`;
   if(account)h+=`<div class="lab-card">${avatarHtml(account.profile)}<label for="lab-name">Имя общего аккаунта</label><input id="lab-name" maxlength="24" value="${esc(lab.nick())}"><button id="lab-save-name">Сохранить имя</button><p id="lab-sync-status" class="lab-status" aria-live="polite">${esc(lab.sync.status.text)}</p><p>${account.friends.length} друзей · ${Object.values(account.data?.history||{}).reduce((n,rows)=>n+rows.filter(e=>e.type==='text'||e.type==='file').length,0)} сообщений</p><button id="lab-sync-now">Синхронизировать сейчас</button><details><summary>Журнал звонков (${account.data?.calls?.length||0})</summary>${(account.data?.calls||[]).slice(-50).reverse().map(c=>`<div class="lab-row"><span>${esc(c.nick||'Звонок')} · ${esc(c.outcome==='connected'?'Состоялся':c.outcome==='missed'?'Пропущен':'Без соединения')}</span><span>${esc(new Date(c.ts).toLocaleString('ru-RU'))} · ${esc(c.duration||0)} с</span></div>`).join('')||'<p>Звонков пока нет</p>'}</details>${account.devices.map(d=>`<div class="lab-row"><span>${esc(d.name)}</span><span class="lab-code">${esc(d.id.slice(0,10))}…</span></div>`).join('')}</div>${note}<p class="lab-muted lab-small">Аватар меняется в настройках профиля, друзья — в обычном списке приложения.</p>`;
   else h+=`<div class="lab-card"><label for="lab-name">Имя профиля</label><input id="lab-name" maxlength="24" value="${esc(lab.nick())}" placeholder="Ваше имя"><button id="lab-save-name">Сохранить имя</button></div><div class="lab-grid"><div class="lab-card"><h3>Добавить устройство</h3><p>Показать код на этом устройстве.</p><button id="lab-create" class="primary">Создать код подключения</button></div><div class="lab-card"><h3>У меня есть код</h3><label for="lab-join-code">Код с другого устройства</label><textarea id="lab-join-code" rows="3" placeholder="ALOP1.…"></textarea><div class="lab-actions"><button id="lab-paste">Вставить</button><button id="lab-join" class="primary">Подключиться</button></div></div></div>${note}`;
  }else if(s.phase==='invite'){
   h=`<h2>Подключить устройство</h2><p>На втором устройстве откройте «Настройки → Аккаунт и устройства» и вставьте этот код.</p><textarea id="lab-invite" readonly rows="4" class="lab-code">${esc(s.code)}</textarea><button id="lab-copy">Скопировать код</button><p class="lab-muted lab-small">Срок действия — 5 минут. Передавайте код только своему устройству.</p>`;
   h+=pending.length?pending.map(p=>`<div class="lab-card"><h3>Запрос от ${esc(p.nick||'устройства')}</h3><p class="lab-code">${esc(p.id.slice(0,12))}…</p><button data-accept="${esc(p.id)}" class="primary">Это моё устройство</button></div>`).join(''):'<p class="lab-status">Ожидаем второе устройство…</p>';
  }else if(s.phase==='linking')h='<h2>Устанавливаем связь</h2><p>На устройстве с кодом подтвердите, что подключаете своё устройство.</p><p class="lab-muted">Оба приложения должны быть открыты. Для первого подключения используйте одну Wi-Fi сеть.</p>';
  else if(s.phase==='verify')h=`<h2>Сравните проверочный код</h2><p>На обоих устройствах должны совпасть все четыре группы.</p><div class="lab-card lab-phrase">${esc(s.phrase)}</div><p>${s.localVerified?'Подтверждено здесь.':'Подтвердите совпадение на этом устройстве.'} ${s.remoteVerified?'Второе устройство подтвердило.':'Ждём подтверждения второго устройства.'}</p><button id="lab-verify" class="primary" ${s.localVerified?'disabled':''}>Коды совпадают</button>`;
  else if(s.phase==='exchange')h='<h2>Получаем данные устройства</h2><p>Подключение подтверждено. Передаём профиль и список друзей по зашифрованному каналу.</p>';
  else if(s.phase==='choices'){
   if(s.role==='peer')h='<h2>Данные переданы</h2><p>На устройстве, которое создало код, разрешите несостыковки. Затем результат появится здесь для подтверждения.</p>';
   else{const c=e.getConflicts();if(!c.profile&&!c.contacts.length){h='<h2>Данные совпадают</h2><p>Выбор не требуется. Готовим общий список…</p>';setTimeout(autoPropose,0)}else{
    h='<h2>Нужно уточнить различия</h2><p class="lab-muted">Совпадения обработаны автоматически. Здесь только несостыковки.</p>';
    if(c.profile)h+=`<h3>Имя и аватар профиля</h3><div class="lab-grid">${profileCard(s.local.profile,'Это устройство','host')}${profileCard(s.remote.profile,'Второе устройство','peer')}</div>`;
    for(const c0 of c.contacts)h+=`<div class="lab-card"><h3>Разные подписи одного контакта</h3><p class="lab-code">${esc(c0.id.slice(0,12))}…</p><select data-contact="${esc(c0.id)}"><option value="">Выберите подпись</option><option value="host">${esc(c0.host)} — здесь</option><option value="peer">${esc(c0.peer)} — на втором устройстве</option></select></div>`;
    h+='<button id="lab-propose" class="primary">Проверить результат</button>';
   }}
  }else if(s.phase==='review'){
   const a=s.proposal;h=`<h2>Проверьте общий аккаунт</h2><div class="lab-card">${avatarHtml(a.profile)}<h3>${esc(a.profile.nick)}</h3><p>${a.friends.length} друзей · 2 устройства</p><details><summary>Общий список друзей</summary>${a.friends.map(f=>`<div class="lab-row"><span>${esc(f.nick)}</span><span class="lab-code">${esc(f.id.slice(0,8))}…</span></div>`).join('')}</details></div>${note}<p>${s.remoteApproved?'Второе устройство согласилось.':'Ждём подтверждения второго устройства.'}</p><button id="lab-approve" class="primary" ${s.localApproved?'disabled':''}>${s.localApproved?'Подтверждено здесь':'Подтвердить на этом устройстве'}</button><p class="lab-muted lab-small">Применение начнётся после подтверждения на обоих устройствах.</p>`;
  }else if(s.phase==='committing')h='<h2>Применяем объединение</h2><p>Данные сохранены на этом устройстве. Ждём подтверждения второго. Держите оба приложения открытыми.</p><p class="lab-muted">При перезапуске незавершённая операция будет продолжена.</p>';
  else if(s.phase==='done')h=`<h2>Устройства объединены</h2><div class="lab-card"><h3>${esc(e.account.profile.nick)}</h3><p class="lab-code">Общий аккаунт: ${esc(e.account.id)}</p><p>${e.account.friends.length} друзей сохранены на каждом устройстве.</p></div><p>Можно закрыть приложение на ПК и перезапустить телефон: общий профиль и список друзей останутся на телефоне.</p>${note}<button id="lab-done" class="primary">Мои устройства</button>`;
  else if(s.phase==='expired')h='<h2>Время подключения истекло</h2><p>Данные аккаунтов не объединены. Отмените подключение и создайте новый код.</p>';
  if(s&&!s.localApproved&&!['committing','done'].includes(s.phase))h+='<div class="lab-actions"><button id="lab-cancel">Отменить подключение</button></div>';
  if(!s&&!unlinkPending){
   if(lab.platform==='phone'&&e.account)h+='<div class="lab-actions"><button id="lab-unlink">Отвязать устройство</button></div>';
   h+='<details class="lab-card"><summary>Восстановление до объединения</summary><p>Вернуть локальный профиль, контакты, переписку и настройки из копии на этом устройстве. Изменения после объединения будут заменены. Второе устройство сохраняет свои данные.</p><button id="account-restore">Выбрать копию</button><div id="account-backups"></div></details>';
  }
  $('lab-view').innerHTML=h;
  bind('account-restore',()=>recovery.choose($('account-backups')));
  bind('lab-unlink',()=>{
   if(unlinkPending||confirm('Отвязать второе устройство? Синхронизация прекратится. Профиль, контакты, переписка и настройки сохранятся на телефоне.'))return recovery.unlink();
  });
  bind('lab-sync-now',async()=>{await lab.sync.tick();await window.accountLabData.tick()});bind('lab-create',()=>e.create());bind('lab-save-name',()=>lab.setName($('lab-name').value));bind('lab-paste',async()=>{$('lab-join-code').value=await lab.paste()});bind('lab-join',()=>e.join($('lab-join-code').value));bind('lab-copy',()=>lab.copy(s.code));
  panel.querySelectorAll('[data-accept]').forEach(b=>b.onclick=()=>action(()=>e.acceptDevice(b.dataset.accept)));
  bind('lab-verify',()=>e.verify());bind('lab-cancel',()=>e.cancel());bind('lab-approve',()=>e.approve());bind('lab-done',()=>e.closeDone());bind('lab-reload',()=>lab.platform==='desktop'?duo.accountRecoveryReload():location.reload());
  bind('lab-propose',()=>{const choices={contacts:{}};const selected=panel.querySelector('input[name="lab-profile"]:checked');if(selected)choices.profile=selected.value;panel.querySelectorAll('[data-contact]').forEach(el=>choices.contacts[el.dataset.contact]=el.value);return e.propose(choices)});
 }
 lab.closePanel=()=>{if(panel.hidden)return false;panel.hidden=true;entry.focus();try{if(typeof renderFriends==='function')renderFriends()}catch{}return true};
 entry.onclick=()=>{panel.hidden=false;render()};$('lab-hide').onclick=lab.closePanel;
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&lab.closePanel()){event.preventDefault();event.stopImmediatePropagation()}},true);
 window.addEventListener('account-lab-change',render);
 setInterval(async()=>{if(e.s?.phase!=='invite')return;try{const result=await lab.api.pending();pending=result.incoming||[];render()}catch{}},1500);
 lab.ready.then(()=>{if(e.s)panel.hidden=false;render()});render();
})();
