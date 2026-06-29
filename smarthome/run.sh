#!/bin/sh
set -e

OPTIONS="/data/options.json"

MQTT_URL=$(jq -r '.mqtt_url // "mqtt://localhost:1883"' $OPTIONS)
MQTT_USER=$(jq -r '.mqtt_user // ""' $OPTIONS)
MQTT_PASS=$(jq -r '.mqtt_pass // ""' $OPTIONS)
YEMOT_API_TOKEN=$(jq -r '.yemot_api_token // ""' $OPTIONS)
YEMOT_API_LINK_URL=$(jq -r '.yemot_api_link_url // ""' $OPTIONS)
ADMIN_PASSWORD=$(jq -r '.admin_password // ""' $OPTIONS)
CONTROLLERS=$(jq -c '.controllers // []' $OPTIONS)

# ADMIN_PASSWORD מועבר כ-EMERGENCY_PASSWORD —
# כך הכניסה עובדת גם לפני שמשתמשים הוגדרו במימשק,
# ועם כל שם משתמש (הקוד מחפש admin ואם לא נמצא לוקח ראשון)
export CONFIG_JSON="{\"MQTT_URL\":\"${MQTT_URL}\",\"MQTT_USER\":\"${MQTT_USER}\",\"MQTT_PASS\":\"${MQTT_PASS}\",\"YEMOT_PHONE_MAP\":{},\"CONTROLLERS\":${CONTROLLERS},\"USERS\":[{\"name\":\"admin\",\"password\":\"placeholder_will_be_overridden\",\"role\":\"admin\",\"relays\":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]}],\"EMERGENCY_PASSWORD\":\"${ADMIN_PASSWORD}\"}"

export YEMOT_API_TOKEN
export YEMOT_API_LINK_URL
export PORT=3000

echo "🚀 מפעיל שרת בית חכם..."
exec node /app/index.js
