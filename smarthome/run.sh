#!/bin/sh
set -e

OPTIONS="/data/options.json"

MQTT_URL=$(jq -r '.mqtt_url // "mqtt://localhost:1883"' $OPTIONS)
MQTT_USER=$(jq -r '.mqtt_user // ""' $OPTIONS)
MQTT_PASS=$(jq -r '.mqtt_pass // ""' $OPTIONS)
YEMOT_API_TOKEN=$(jq -r '.yemot_api_token // ""' $OPTIONS)
YEMOT_API_LINK_URL=$(jq -r '.yemot_api_link_url // ""' $OPTIONS)
ADMIN_PASSWORD=$(jq -r '.admin_password // ""' $OPTIONS)
CONTROLLERS=$(jq -c '[.controllers[] | {id: .id, name: .name, topic: .topic, relayCount: .relay_count, relayNames: {}}] // []' $OPTIONS)
GITHUB_REPO=$(jq -r '.github_repo // ""' $OPTIONS)

export CONFIG_JSON="{\"MQTT_URL\":\"${MQTT_URL}\",\"MQTT_USER\":\"${MQTT_USER}\",\"MQTT_PASS\":\"${MQTT_PASS}\",\"YEMOT_PHONE_MAP\":{},\"CONTROLLERS\":${CONTROLLERS},\"USERS\":[{\"name\":\"admin\",\"password\":\"placeholder_will_be_overridden\",\"role\":\"admin\",\"relays\":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]}],\"EMERGENCY_PASSWORD\":\"${ADMIN_PASSWORD}\"}"

export YEMOT_API_TOKEN
export YEMOT_API_LINK_URL
export PORT=3000

# עדכון אוטומטי מ-GitHub בכל הפעלה
if [ -n "$GITHUB_REPO" ]; then
  BASE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/main/smarthome"
  echo "🔄 מוריד קבצים עדכניים מ-GitHub: ${GITHUB_REPO}..."
  TS=$(date +%s)
  wget -q -O /app/smart_home_v3.html "${BASE_URL}/smart_home_v3.html?ts=${TS}" && echo "✅ smart_home_v3.html עודכן" || echo "⚠️ לא הצליח להוריד HTML"
  wget -q -O /app/index.js "${BASE_URL}/index.js?ts=${TS}" && echo "✅ index.js עודכן" || echo "⚠️ לא הצליח להוריד index.js"
fi

echo "🚀 מפעיל שרת בית חכם..."
exec node /app/index.js
