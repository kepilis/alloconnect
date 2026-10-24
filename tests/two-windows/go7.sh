#!/bin/bash
T=<TEST_ROOT>/test4
E=<ELECTRON>
rm -rf $T/sh7; mkdir -p $T/sh7
Xvfb :88 -screen 0 1600x1000x24 >/dev/null 2>&1 & XP=$!
sleep 1
for R in A B; do
ROLE=$R SHARED=$T/sh7 VIDS=$T/vids ALOCALLS_USERDATA=$T/ud/$R ALOCALLS_FAKE_HELPER=$T/fake-helper.js FAKE_LOG=$T/sh7/fake$R DISPLAY=:88 $E --no-sandbox --autoplay-policy=no-user-gesture-required $T/app7 > $T/o7$R.txt 2>&1 &
eval P$R=$!
done
wait $PA $PB; kill $XP 2>/dev/null
