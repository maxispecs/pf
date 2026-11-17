#!/usr/bin/env bash
. $GWHOME/services/arbiter/inc/boot.sh
if [ "$1" = "deploy" ] || [ "$1" = "d" ]; then cmd="deploy"; fi
sudo systemctl restart prefect-worker
