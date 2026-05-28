#!/bin/bash
while true; do
  echo "[$(date)] Starting pumpfun bot..."
  node dist/main.js 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Bot exited with code $EXIT_CODE, restarting in 5s..."
  sleep 5
done
