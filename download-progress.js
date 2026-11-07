/* Visible lifecycle for optional components and media; all strings render as text. */
(() => {
  const panel=document.getElementById('downloadsPanel'),list=document.getElementById('downloadsList'),toggle=document.getElementById('downloadsToggle');
  let hideTimer=null,manual=false;
  const placePanel=()=>{
    if(panel.classList.contains('hidden'))return;
    const b=toggle.getBoundingClientRect();
    panel.style.left=Math.max(8,Math.min(innerWidth-panel.offsetWidth-8,b.right-panel.offsetWidth))+'px';
    panel.style.top=Math.max(8,Math.min(innerHeight-panel.offsetHeight-8,b.bottom+8))+'px';
  };
  const placeToggle=()=>{
    const call=document.getElementById('call'),group=document.getElementById('group');
    const status=call.classList.contains('active')?document.getElementById('status'):group.classList.contains('active')?document.getElementById('gStatus'):null;
    if(status){if(toggle.previousElementSibling!==status)status.after(toggle)}
    else if(toggle.parentElement!==document.body)document.body.append(toggle);
    placePanel();
  };
  for(const id of ['lobby','call','group'])new MutationObserver(placeToggle).observe(document.getElementById(id),{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',placePanel);
  placeToggle();
  const autoShow=()=>{try{return JSON.parse(localStorage.getItem('duo.settings')||'{}').downloadsAuto!==false}catch{return true}};
  const duration=()=>{try{const raw=JSON.parse(localStorage.getItem('duo.settings')||'{}').downloadsDuration,n=raw==null?3:Number(raw);return Number.isInteger(n)&&n>=0&&n<=10?n:3}catch{return 3}};
  const peek=()=>{if(manual||!autoShow())return;panel.classList.remove('hidden');placePanel();clearTimeout(hideTimer);const seconds=duration();if(seconds)hideTimer=setTimeout(()=>panel.classList.add('hidden'),seconds*1000)};
  const rows=new Map(),terminal=new Set(['ready','error','cancelled']);
  const mb=n=>(Math.max(0,Number(n)||0)/1048576).toFixed(1)+' МБ';
  const labels={starting:'Подготовка…',checking:'Проверка установленных файлов…',download:'Скачивание…',verify:'Проверка целостности…',install:'Установка…',loading:'Запуск нейросети…',processing:'Обработка…',retry:'Повторная попытка…',ready:'Готово — можно использовать',error:'Загрузка не завершена',cancelled:'Загрузка отменена'};
  function update(d){
    if(!d||typeof d.id!=='string'||d.id.length>64)return;
    let row=rows.get(d.id);const isNew=!row;if(!row){if(rows.size>=12){const old=[...rows].find(([,r])=>terminal.has(r.stage));if(old){old[1].el.remove();rows.delete(old[0])}else return}
      const el=document.createElement('section'),title=document.createElement('b'),status=document.createElement('div'),bar=document.createElement('progress'),amount=document.createElement('small');el.className='download-row';status.className='download-status';bar.max=100;el.append(title,status,bar,amount);list.append(el);row={el,title,status,bar,amount};rows.set(d.id,row);
    }
    const wasTerminal=terminal.has(row.stage);row.stage=d.stage||'starting';row.title.textContent=String(d.title||'Загрузка').slice(0,80);row.status.textContent=String(d.message||labels[row.stage]||labels.starting).slice(0,250);row.el.dataset.stage=row.stage;row.el.dataset.downloadId=d.id;
    const total=Math.max(0,Number(d.total)||0),got=Math.max(0,Number(d.got)||0);
    if(row.stage==='ready'){row.bar.value=100;row.amount.textContent='Готово'}
    else if(row.stage==='download'&&total>0){const pct=Math.min(100,Math.floor(got/total*100));row.bar.value=pct;row.amount.textContent=pct+'% · '+mb(got)+' / '+mb(total)}
    else {row.bar.removeAttribute('value');row.amount.textContent=row.stage==='download'&&!total?mb(got)+' · общий объём неизвестен':total>0?mb(got)+' / '+mb(total):''}
    if(row.stage==='error'||row.stage==='cancelled'){row.bar.hidden=true;row.status.setAttribute('role','alert')}else{row.bar.hidden=false;row.status.removeAttribute('role')}
    const active=[...rows.values()].filter(r=>!terminal.has(r.stage)).length;
    toggle.textContent=active?'⬇ Загрузки: '+active:'⬇ Загрузки';toggle.classList.remove('hidden');toggle.classList.toggle('busy',!!active);
    if(!d.background&&((isNew||wasTerminal)&&!terminal.has(row.stage)||row.stage==='error'))peek();
  }
  toggle.onclick=()=>{clearTimeout(hideTimer);manual=panel.classList.contains('hidden');panel.classList.toggle('hidden');placePanel()};document.getElementById('downloadsHide').onclick=()=>{clearTimeout(hideTimer);manual=false;panel.classList.add('hidden')};
  document.getElementById('downloadsClear').onclick=()=>{for(const [id,row] of rows)if(terminal.has(row.stage)){row.el.remove();rows.delete(id)}if(!rows.size){panel.classList.add('hidden');toggle.classList.add('hidden');manual=false}};
  document.getElementById('downloadsClear').title='Удалить завершённые загрузки из списка. Текущие продолжатся.';
  window.downloadProgress=update;
  window.duo.onDownloadProgress(update);
})();
