#!/usr/bin/env bash
# Round 15 — aggressive self-hunting driver.
# Pumps a live hunt through all 8 stages via the public API (exactly what the
# UI's auto-pump does), logging every stage transition. Usage: hunt-pump.sh <huntId>
HUNT_ID="${1:?hunt id required}"
LOG="/home/z/my-project/reports/state/hunt-${HUNT_ID}-pump.log"
API="http://localhost:3000/api/live-hunt"

echo "[$(date +%H:%M:%S)] pumping hunt #${HUNT_ID}" > "$LOG"
for i in $(seq 1 40); do
  RESP=$(curl -s --max-time 420 -X POST "$API" -H 'Content-Type: application/json' -d "{\"action\":\"next\",\"id\":${HUNT_ID}}")
  STATUS=$(echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("hunt",{}).get("status","?"))' 2>/dev/null || echo "parse-error")
  STAGE=$(echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("hunt",{}).get("stageKey","?"))' 2>/dev/null || echo "?")
  DNA=$(echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("hunt",{}).get("dnaAfter","?"))' 2>/dev/null || echo "?")
  echo "[$(date +%H:%M:%S)] pump ${i}: status=${STATUS} stage=${STAGE} dnaAfter=${DNA}" >> "$LOG"
  if [ "$STATUS" != "running" ] && [ "$STATUS" != "parse-error" ]; then
    echo "[$(date +%H:%M:%S)] hunt #${HUNT_ID} finished: ${STATUS}" >> "$LOG"
    break
  fi
  sleep 2
done
