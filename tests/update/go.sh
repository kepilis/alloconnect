#!/bin/bash
U=<TEST_ROOT>/updtest
R=<TEST_ROOT>/test4
E=<ELECTRON>
cp $U/hu.js $U/appA/hu.js; cp $U/hu.js $U/appB/hu.js
node -e "const f='$U/appA/package.json';const p=require(f);p.main='hu.js';require('fs').writeFileSync(f,JSON.stringify(p))"
node -e "const f='$U/appB/package.json';const p=require(f);p.main='hu.js';require('fs').writeFileSync(f,JSON.stringify(p))"
rm -rf $U/sh $U/udA $U/udB; mkdir -p $U/sh $U/udA $U/udB
cp $R/ud/A/identity.json $R/ud/A/friends.json $U/udA/ 2>/dev/null
cp $R/ud/B/identity.json $R/ud/B/friends.json $U/udB/ 2>/dev/null
node - <<NODE
const fs=require('fs'),crypto=require('crypto');
function id(dir){const s=JSON.parse(fs.readFileSync(dir+'/identity.json'));const pk=crypto.createPublicKey(crypto.createPrivateKey(s.priv));return pk.export({format:'jwk'}).x;}
const idA=id('$U/udA'), idB=id('$U/udB');
fs.writeFileSync('$U/udA/net.json',JSON.stringify({port:45001}));
fs.writeFileSync('$U/udB/net.json',JSON.stringify({port:45002}));
fs.writeFileSync('$U/udA/friends.json',JSON.stringify([{id:idB,nick:'userB',addrs:[{kind:'lan',ip:'127.0.0.1',port:45002}]}]));
fs.writeFileSync('$U/udB/friends.json',JSON.stringify([{id:idA,nick:'userA',addrs:[{kind:'lan',ip:'127.0.0.1',port:45001}]}]));
console.log('seeded ids+ports');
NODE
Xvfb :91 -screen 0 1400x900x24 >/dev/null 2>&1 & XP=$!
sleep 1
ROLE=A SHARED=$U/sh ALOCALLS_USERDATA=$U/udA ALOCALLS_UPDATE_DIR=$U/updA ALOCALLS_FAKE_HELPER=$U/fake-helper.js DISPLAY=:91 $E --no-sandbox $U/appA > $U/oA.txt 2>&1 & PA=$!
ROLE=B SHARED=$U/sh ALOCALLS_USERDATA=$U/udB ALOCALLS_UPDATE_DIR=$U/updB ALOCALLS_FAKE_HELPER=$U/fake-helper.js DISPLAY=:91 $E --no-sandbox $U/appB > $U/oB.txt 2>&1 & PB=$!
wait $PA $PB; kill $XP 2>/dev/null
