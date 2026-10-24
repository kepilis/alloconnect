#!/bin/bash
T=<TEST_ROOT>/test4
D=<SRC>
rm -rf $T/app $T/sh $T/ud; mkdir -p $T/app $T/sh $T/ud/A $T/ud/B
cp -r <TEST_ROOT>/verify/asar/* $T/app/
cp $T/harness4.js $T/app/
echo '{"name":"alloconnect-it","version":"1.10.0","main":"harness4.js"}' > $T/app/package.json
E=$D/node_modules/electron/dist/electron
Xvfb :77 -screen 0 1600x1000x24 >/dev/null 2>&1 &
XP=$!
node <TEST_ROOT>/stunt/fake-stun.js 3478,3480,3482 $T/sh/stuncounts.json >/dev/null 2>&1 &
SP=$!
sleep 1
for R in A B; do
  ROLE=$R SHARED=$T/sh ALOCALLS_USERDATA=$T/ud/$R ALOCALLS_FAKE_HELPER=$T/fake-helper.js FAKE_LOG=$T/sh/fake$R \
    DISPLAY=:77 $E --no-sandbox $T/app > $T/sh/out$R.log 2>&1 &
  eval P$R=$!
  sleep 1
done
wait $PA $PB; kill $XP $SP
