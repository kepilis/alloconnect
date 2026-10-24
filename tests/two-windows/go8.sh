#!/bin/bash
T=<TEST_ROOT>/test4
E=<ELECTRON>
rm -rf $T/sh8; mkdir -p $T/sh8
Xvfb :89 -screen 0 1600x1000x24 >/dev/null 2>&1 & XP=$!
sleep 1
for R in A B; do
ROLE=$R SHARED=$T/sh8 VIDS=$T/vids ALOCALLS_USERDATA=$T/ud8/$R ALOCALLS_FAKE_HELPER=$T/fake-helper.js FAKE_LOG=$T/sh8/fake$R DISPLAY=:89 $E --no-sandbox --autoplay-policy=no-user-gesture-required $T/app8 > $T/o8$R.txt 2>&1 &
eval P$R=$!
done
wait $PA $PB; kill $XP 2>/dev/null
