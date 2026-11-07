'use strict';
const fs=require('fs'),path=require('path');
class MessageOutbox {
 constructor(file,transport,status){this.file=file;this.transport=transport;this.status=status;this.busy=new Set();this.rows=[];try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(data))this.rows=data.filter(r=>r&&typeof r.id==='string'&&r.msg?.t==='dm'&&typeof r.msg.mid==='string'&&typeof r.msg.text==='string').slice(0,1000)}catch{} }
 persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.rows));fs.renameSync(tmp,this.file)}
 add(id,msg){if(this.rows.some(r=>r.id===id&&r.msg.mid===msg.mid))return;if(this.rows.length>=1000)throw Error('Очередь заполнена (1000 сообщений)');this.rows.push({id,msg});try{this.persist()}catch(e){this.rows.pop();throw e}}
 changePending(id,ref,op){const row=this.rows.find(r=>r.id===id&&r.msg.mid===ref);if(!row)return null;if(this.busy.has(id))return {ok:false,error:'Сообщение сейчас отправляется. Повтори действие после доставки.'};const before=this.rows.map(r=>({...r,msg:{...r.msg}}));if(op.op==='del')this.rows=this.rows.filter(r=>r!==row);else row.msg={...row.msg,text:op.text};try{this.persist();return {ok:true,queued:true}}catch(e){this.rows=before;return {ok:false,error:e.message}}}
 async flush(id){if(this.busy.has(id))return;this.busy.add(id);try{while(true){const row=this.rows.find(r=>r.id===id);if(!row)return;try{await this.transport(id,row.msg)}catch{return}const idx=this.rows.indexOf(row);this.rows.splice(idx,1);try{this.persist()}catch(e){this.rows.splice(idx,0,row);return}this.status?.(id,row.msg.mid)}}finally{this.busy.delete(id)}}
}
module.exports={MessageOutbox};
