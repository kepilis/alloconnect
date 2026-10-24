#!/bin/bash
T=<TEST_ROOT>/test4
E=<ELECTRON>
rm -rf $T/sh9; mkdir -p $T/sh9
Xvfb :90 -screen 0 1600x1000x24 >/dev/null 2>&1 & XP=$!
sleep 1
for R in A B; do
ROLE=$R SHARED=$T/sh9 VIDS=$T/vids ALOCALLS_USERDATA=$T/ud8/$R ALOCALLS_FAKE_HELPER=$T/fake-helper.js FAKE_LOG=$T/sh9/fake$R DISPLAY=:90 $E --no-sandbox --autoplay-policy=no-user-gesture-required $T/app9 > $T/o9$R.txt 2>&1 &
eval P$R=$!
done
wait $PA $PB; kill $XP 2>/dev/null
