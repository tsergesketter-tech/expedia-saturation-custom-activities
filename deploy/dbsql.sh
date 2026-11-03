#!/bin/bash
# Run one SQL statement on the demo warehouse: deploy/dbsql.sh "<sql>"
WAREHOUSE=${DBX_WAREHOUSE_ID:?set DBX_WAREHOUSE_ID}
TMP=$(mktemp)
python3 -c 'import json,sys;print(json.dumps({"warehouse_id":sys.argv[2],"statement":sys.argv[1],"wait_timeout":"50s","on_wait_timeout":"CONTINUE"}))' "$1" "$WAREHOUSE" > "$TMP"
databricks api post /api/2.0/sql/statements --profile "${DATABRICKS_PROFILE:?set DATABRICKS_PROFILE}" --json @"$TMP" | python3 -c '
import sys,json;d=json.load(sys.stdin);s=d.get("status",{});print(s.get("state"),s.get("error",{}).get("message","")[:400])
for r in (d.get("result") or {}).get("data_array") or []: print("  ",r)'
rm -f "$TMP"
