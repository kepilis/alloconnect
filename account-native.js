'use strict';
(()=>{
 if(typeof window.duo?.onFriendMsg==='function')return;
 class NativeManager extends AccountSync.Manager{
  async init(){await super.init();if(this.state)await this.network();return true}
  async persist(state,observed){const r=await alo.accountLabSyncCommit({base:JSON.stringify(this.state),state:JSON.stringify(state)});if(!r?.ok)throw Error(r?.error||'Не удалось сохранить изменения аккаунта');await this.adopt(r)}
  async adopt(r){if(!r?.ok)throw Error(r?.error||'Не удалось прочитать аккаунт');const record=r.record;if(!record?.account||!record.sync)return;const next=AccountSync.validate(record.sync.state,record.account);if(!this.state||AccountSync.stable(next)!==AccountSync.stable(this.state))await this.a.applySynced(record.account);
   this.e.account=record.account;this.e.receipt=record.receipt;this.e.syncState=record.sync;this.e.syncRecovery=null;this.state=next;this.hash=record.sync.hash;this.ackedHash=record.sync.ackedHash;this.lastAckAt=record.sync.ackedAt||0;this.lastPeerAt=r.status?.lastPeerAt||0;this.lastPeerHash=r.status?.lastPeerHash||null;this.observed=AccountSync.semantic(record.account);this.nativeStatus=r.status;this.error='';this.localError='';this.updateStatus();
  }
  async network(){return this.enqueue(async()=>{if(!await this.ensure())return;await this.adopt(await alo.accountLabSyncPoll())})}
  receive(){return Promise.resolve()}
  updateStatus(){if(this.nativeStatus){this.status={...this.nativeStatus};if(this.localError)this.status.text='Синхронизация: '+this.localError;this.e.emit()}else super.updateStatus()}
 }
 window.AccountNativeManager=NativeManager;
})();
