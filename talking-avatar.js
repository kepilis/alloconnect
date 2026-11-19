/* AlloConnect: one-time mouth preparation; no inference or animation timer in calls. */
(() => {
  'use strict';
  const SIZE = 192, COUNT = 6, KEY = 'AlloMouth', LIMIT = 2 * 1024 * 1024;
  const cache = new Map(), bindings = new WeakMap();
  let queue = Promise.resolve();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function valid(r) {
    return r && r.v === 1 && ['x','y','w','h','angle','strength'].every(k => Number.isFinite(r[k])) &&
      r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1 && r.w >= .04 && r.w <= .8 &&
      r.h >= 0 && r.h <= .4 && Math.abs(r.angle) <= Math.PI && r.strength >= .01 && r.strength <= .25;
  }
  function crc(bytes) {
    let c = -1;
    for (const b of bytes) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (c ^ -1) >>> 0;
  }
  function readRig(bytes) {
    if (bytes.length < 20 || bytes.length > LIMIT || ![137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let p = 8; p + 12 <= bytes.length;) {
      const n = view.getUint32(p); if (n > bytes.length - p - 12) return null;
      if (n < 1024 && String.fromCharCode(...bytes.subarray(p+4,p+8)) === 'tEXt') {
        const data = bytes.subarray(p+8,p+8+n), zero = data.indexOf(0);
        if (zero === KEY.length && new TextDecoder().decode(data.subarray(0,zero)) === KEY && crc(bytes.subarray(p+4,p+8+n)) === view.getUint32(p+8+n)) {
          try { const r = JSON.parse(new TextDecoder().decode(data.subarray(zero+1))); return valid(r) ? r : null; } catch { return null; }
        }
      }
      p += n + 12;
    }
    return null;
  }
  function embed(bytes, rig) {
    if (!valid(rig)) throw Error('Некорректное положение рта');
    // Canvas PNG always ends with the 12-byte IEND chunk.
    const data = new TextEncoder().encode(KEY + '\0' + JSON.stringify(rig));
    const chunk = new Uint8Array(data.length + 12), v = new DataView(chunk.buffer);
    v.setUint32(0,data.length); chunk.set([116,69,88,116],4); chunk.set(data,8);
    v.setUint32(data.length+8,crc(chunk.subarray(4,data.length+8)));
    const out = new Uint8Array(bytes.length+chunk.length);
    out.set(bytes.subarray(0,bytes.length-12)); out.set(chunk,bytes.length-12); out.set(bytes.subarray(bytes.length-12),bytes.length-12+chunk.length);
    return out;
  }
  function canvas(size = SIZE) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
  async function decode(blob, size = SIZE) {
    const bmp = await createImageBitmap(blob);
    try {
      if (!bmp.width || !bmp.height) throw Error('Пустая картинка');
      const c = canvas(size), s = Math.min(bmp.width,bmp.height);
      c.getContext('2d').drawImage(bmp,(bmp.width-s)/2,(bmp.height-s)/2,s,s,0,0,size,size);
      return c;
    } finally { bmp.close(); }
  }
  // Inverse warp in mouth coordinates. Original pixels form both lips and chin.
  // The dark cavity is exposed between them; no separate mouth image is drawn.
  function frame(source, rig, amount) {
    const n = source.width, c = canvas(n), ctx = c.getContext('2d');
    ctx.drawImage(source,0,0); if (!amount) return c;
    const input = source.getContext('2d').getImageData(0,0,n,n), output = ctx.getImageData(0,0,n,n);
    const src = input.data, dst = output.data, co = Math.cos(rig.angle), si = Math.sin(rig.angle);
    const cx = rig.x*n, cy = rig.y*n, radius = rig.w*n*.62, height = Math.max(rig.w*n*.65,rig.h*n*1.5);
    const opening = rig.w*n*rig.strength*amount;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx=x-cx,dy=y-cy,u=dx*co+dy*si,v=-dx*si+dy*co;
      const ux=Math.abs(u)/radius,vy=Math.abs(v)/height; if (ux>=1 || vy>=1) continue;
      const horizontal=Math.pow(1-ux*ux,2), falloff=Math.pow(1-vy,2);
      const shift=opening*horizontal, top=-shift*.25, bottom=shift;
      const i=(y*n+x)*4;
      if (v>top && v<bottom) {
        const edge=clamp(Math.min(v-top,bottom-v)*1.5,0,1);
        // Blend at the lip boundary, preserve transparent regions of the avatar.
        for(let k=0;k<3;k++) dst[i+k]=src[i+k]*(1-edge)+[30,16,20][k]*edge;
        continue;
      }
      const sv=v-(v>=0 ? shift : -shift*.25)*falloff;
      const sx=clamp(cx+u*co-sv*si,0,n-1),sy=clamp(cy+u*si+sv*co,0,n-1);
      const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(n-1,x0+1),y1=Math.min(n-1,y0+1),fx=sx-x0,fy=sy-y0;
      for(let k=0;k<4;k++) dst[i+k]=(src[(y0*n+x0)*4+k]*(1-fx)+src[(y0*n+x1)*4+k]*fx)*(1-fy)+(src[(y1*n+x0)*4+k]*(1-fx)+src[(y1*n+x1)*4+k]*fx)*fy;
    }
    ctx.putImageData(output,0,0); return c;
  }
  async function frames(source, rig) {
    const result = [source];
    for (let i=1;i<COUNT;i++) { await new Promise(r=>setTimeout(r,0)); result.push(frame(source,rig,i/(COUNT-1))); }
    return result;
  }
  async function prepare(url) {
    const blob = await (await fetch(url)).blob(); if (blob.size>LIMIT) return null;
    const rig = readRig(new Uint8Array(await blob.arrayBuffer()));
    if (!rig) return null;
    return frames(await decode(blob),rig);
  }
  function cached(url) {
    if (cache.has(url)) { const p=cache.get(url); cache.delete(url); cache.set(url,p); return p; }
    const p=queue.then(()=>prepare(url)).catch(()=>null); queue=p.then(()=>{});
    cache.set(url,p); while(cache.size>12) cache.delete(cache.keys().next().value);
    return p;
  }
  function bind(el,url) {
    if (!el || !el.closest('#meCard,#friendCard,.gtile')) return;
    const old=bindings.get(el); if(old?.url===url) return;
    old?.canvas?.remove(); const state={url,level:0,index:0}; bindings.set(el,state);
    if (!url) return;
    cached(url).then(list=>{
      if(!list || bindings.get(el)!==state) return;
      state.frames=list; state.canvas=canvas(); state.canvas.className='talking-avatar-canvas'; state.canvas.hidden=true;
      state.canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none';
      if(getComputedStyle(el).position==='static') el.style.position='relative';
      el.append(state.canvas);
    });
  }
  function level(card,value) {
    const el=card?.querySelector('.avatar'), state=el && bindings.get(el);
    if (!state?.frames) return;
    const active=Number.isFinite(value) && value>.012 && card.classList.contains('speaking') && !document.hidden && el.getClientRects().length;
    const target=active ? clamp((value-.012)/.12,0,1) : 0;
    state.level=active ? state.level+(target-state.level)*(target>state.level ? .75 : .5) : 0;
    const index=clamp(Math.round(state.level*(COUNT-1)),0,COUNT-1);
    if(!index) { state.canvas.hidden=true; state.index=0; return; }
    if(index!==state.index || state.canvas.hidden) state.canvas.getContext('2d').drawImage(state.frames[index],0,0);
    state.canvas.hidden=false; state.index=index;
  }
  async function detect(source) {
    // Destroy the inference realm afterwards, releasing its Wasm heap as well as the model.
    const bitmap=await createImageBitmap(source);
    return new Promise((resolve,reject)=>{
      const host=document.createElement('iframe'),token=crypto.randomUUID();host.hidden=true;
      const finish=(error,value)=>{clearTimeout(timeout);window.removeEventListener('message',receive);host.remove();bitmap.close();error?reject(error):resolve(value);};
      const receive=e=>{if(e.source!==host.contentWindow || e.data?.token!==token)return;finish(e.data.error?Error(e.data.error):null,valid(e.data.rig)?e.data.rig:null);};
      const timeout=setTimeout(()=>finish(Error('Превышено время поиска лица')),30000);
      window.addEventListener('message',receive);
      host.onload=()=>host.contentWindow.postMessage({token,bitmap},'*',[bitmap]);
      host.onerror=()=>finish(Error('Не удалось загрузить поиск лица'));
      host.src=new URL('mouth-detector.html',document.baseURI).href;document.body.append(host);
    });
  }
  let editorOpen=false,closeCurrent=null;
  function closeEditor() { if(!closeCurrent)return false;closeCurrent();return true; }
  document.addEventListener('keydown',e=>{if(e.key==='Escape' && editorOpen){e.preventDefault();e.stopImmediatePropagation();closeEditor();}},true);
  async function edit(url,save) {
    if(editorOpen) return; if(!url) { alert('Сначала выберите аватарку'); return; }
    editorOpen=true;
    let timer,closed=false;
    const dialog=document.createElement('dialog');
    dialog.style.cssText='box-sizing:border-box;width:min(440px,94vw);max-height:90vh;overflow:auto;border:1px solid #64748b;border-radius:16px;background:#182231;color:#f1f5f9;padding:20px;z-index:2147483647;font:14px system-ui';
    dialog.innerHTML=`<h2 style="margin:0 0 10px;font-size:21px">Говорящая аватарка</h2><p>Двигаются губы исходной картинки. Перетащите отметку на середину рта и настройте размер.</p><canvas width="256" height="256" style="display:block;width:min(256px,100%);height:auto;margin:12px auto;touch-action:none;cursor:crosshair"></canvas><p role="status" class="mouth-status">Подготовка…</p><div class="mouth-controls"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"><button type="button" data-action="detect">Найти губы</button><button type="button" data-action="test">Проверить движение</button><button type="button" data-action="save">Сохранить</button><button type="button" data-action="disable">Отключить</button><button type="button" data-action="cancel">Отмена</button></div><p style="font-size:12px;opacity:.75">Поиск лица работает локально. На рисунках положение иногда нужно поправить. При сохранении GIF станет неподвижной картинкой с движением губ.</p>`;
    for(const button of dialog.querySelectorAll('button'))button.style.cssText='background:#334155;color:#f8fafc;border:1px solid #64748b;border-radius:8px;padding:9px 12px;min-height:40px;font:inherit;cursor:pointer';
    document.body.append(dialog); dialog.showModal();
    const display=dialog.querySelector('canvas'),ctx=display.getContext('2d'),status=dialog.querySelector('[role=status]');
    let source,rig,list=null,testing=false,epoch=0,dragging=false;
    const finish=()=>{closed=true;epoch++;clearInterval(timer);dialog.remove();editorOpen=false;closeCurrent=null;};
    closeCurrent=finish;
    dialog.addEventListener('cancel',e=>{e.preventDefault();finish();});
    dialog.querySelector('[data-action=cancel]').onclick=finish;
    const say=s=>{status.textContent=s;};
    const draw=(image=source,marker=true)=>{
      if(!source || closed) return; ctx.clearRect(0,0,256,256);ctx.drawImage(image,0,0,256,256);
      if(marker) { ctx.save();ctx.translate(rig.x*256,rig.y*256);ctx.rotate(rig.angle);ctx.strokeStyle='#4ade80';ctx.lineWidth=2;ctx.strokeRect(-rig.w*128,-Math.max(3,rig.h*128),rig.w*256,Math.max(6,rig.h*256));ctx.beginPath();ctx.moveTo(-5,0);ctx.lineTo(5,0);ctx.moveTo(0,-5);ctx.lineTo(0,5);ctx.stroke();ctx.restore(); }
    };
    const stop=()=>{testing=false;epoch++;clearInterval(timer);timer=null;dialog.querySelector('[data-action=test]').textContent='Проверить движение';};
    const fields=[['w','Ширина рта',.04,.8,.005],['h','Высота губ',0,.3,.005],['angle','Наклон',-90,90,1],['strength','Сила движения',.01,.25,.01]];
    const sync=()=>{for(const [key] of fields) dialog.querySelector(`[name=${key}]`).value=key==='angle'?rig[key]*180/Math.PI:rig[key];};
    for(const [key,title,min,max,step] of fields) {
      const label=document.createElement('label');label.style.cssText='display:block;margin:10px 0';label.textContent=title;
      const input=document.createElement('input');input.type='range';input.name=key;input.min=min;input.max=max;input.step=step;input.style.cssText='display:block;width:100%';
      input.oninput=()=>{if(!rig)return;stop();rig[key]=Number(input.value)*(key==='angle'?Math.PI/180:1);list=null;draw();};label.append(input);dialog.querySelector('.mouth-controls').append(label);
    }
    function move(e) {if(!rig)return;stop();const rect=display.getBoundingClientRect();rig.x=clamp((e.clientX-rect.left)/rect.width,0,1);rig.y=clamp((e.clientY-rect.top)/rect.height,0,1);list=null;draw();}
    display.onpointerdown=e=>{dragging=true;display.setPointerCapture(e.pointerId);move(e);};
    display.onpointermove=e=>{if(dragging)move(e);};display.onpointerup=display.onpointercancel=()=>{dragging=false;};
    const buttons=[...dialog.querySelectorAll('button')].filter(b=>b.dataset.action!=='cancel');
    const busy=value=>{buttons.forEach(b=>b.disabled=value);};
    const autodetect=async()=>{
      if(!source)return;stop();busy(true);say('Ищу губы на устройстве…');
      await new Promise(r=>setTimeout(r,30));
      try {const found=await detect(source);if(closed)return;if(found){rig=found;list=null;sync();draw();say('Губы найдены. Проверьте положение и движение.');}else say('Лицо не найдено. Укажите рот касанием и настройте ширину.');}
      catch{if(!closed)say('Автопоиск недоступен. Укажите рот касанием и настройте ширину.');}
      finally{if(!closed)busy(false);}
    };
    dialog.querySelector('[data-action=detect]').onclick=autodetect;
    dialog.querySelector('[data-action=test]').onclick=async()=>{
      if(!source)return;if(testing){stop();draw();return;}
      const token=++epoch;busy(true);say('Подготавливаю кадры…');
      try {list=list||await frames(source,{...rig});if(closed||token!==epoch)return;testing=true;let t=0;timer=setInterval(()=>{const i=[0,1,3,5,3,1,0,0,2,4,2,0][t++%12];draw(list[i],false);},80);say('Предпросмотр движения. Звук микрофона не используется.');}
      finally{if(!closed){busy(false);dialog.querySelector('[data-action=test]').textContent=testing?'Остановить':'Проверить движение';}}
    };
    const persist=async enabled=>{
      if(!source)return;stop();busy(true);say('Сохраняю…');
      try {
        const blob=await new Promise(r=>source.toBlob(r,'image/png'));
        const raw=new Uint8Array(await blob.arrayBuffer()), bytes=enabled?embed(raw,rig):raw;
        await save(bytes,'image/png'); finish();
      } catch(e){if(!closed){say('Не удалось сохранить: '+e.message);busy(false);}}
    };
    dialog.querySelector('[data-action=save]').onclick=()=>persist(true);
    dialog.querySelector('[data-action=disable]').onclick=()=>persist(false);
    try {
      busy(true);const blob=await(await fetch(url)).blob();if(blob.size>LIMIT)throw Error('Аватарка слишком большая');
      const bytes=new Uint8Array(await blob.arrayBuffer());source=await decode(blob,256);if(closed)return;
      rig=readRig(bytes)||{v:1,x:.5,y:.66,w:.25,h:.025,angle:0,strength:.13};sync();draw();busy(false);
      if(readRig(bytes))say('Положение сохранено в аватарке. Можно проверить и поправить.');else await autodetect();
    } catch(e){if(!closed){say('Не удалось открыть аватарку: '+e.message);busy(true);}}
  }
  window.talkingAvatar={bind,level,edit,closeEditor};
  // Stop immediately on mute/deafen, even if an audio meter has already stopped.
  new MutationObserver(records=>{for(const r of records)if(r.target.matches('#meCard,#friendCard,.gtile') && !r.target.classList.contains('speaking'))level(r.target,0);})
    .observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']});
})();
