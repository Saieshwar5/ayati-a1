#!/bin/bash
# Memory Monitor - Updates every 4 minutes
echo "Memory Monitor Started - Updates every 4 minutes (Press Ctrl+C to stop)"
echo "========================================================="
while true; do
  date
  free -h
  echo "---------------------------------------------------------"
  sleep 240
done
