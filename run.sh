#!/bin/sh
set -e

echo "📂 קורא הגדרות..."

# קרא הגדרות מ-/data/options.json (כך HA מעביר את ה-Configuration)
OPTIONS="/data/options.json"

MQTT_URL=$(cat $OPTIONS | python3 -c "import sys,json; print(json.load(sys.stdin).get('mqtt_url','mqtt://localhost:1883'))")
MQTT_USER=$(cat $OPTIONS | python3 -c "import sys,json; print(json.load(sys.stdin).get('mqtt_user',''))")
MQTT_PASS=$(cat $OPTIONS | python3 -c "import sys,json; print(json.load(sys.stdin).get('mqtt_pass',''))")
YEMOT_API_TOKEN=$(cat $OPTIONS | python3 -c "import sys,json; print(json.load(sys.stdin).get('yemot_api_token',''))")
YEMOT_API_LINK_URL=$(cat $OPTIONS | python3 -c "import sys,json; print(json.load(sys.stdin).get('yemot_api_link_url',''))")
ADMIN_PASSWORD=$(cat $OPTIONS | python3 -c "import sys,json; print(json.load(sys.stdin).get('admin_password','changeme'))")
CONTROLLERS=$(cat $OPTIONS | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('controllers',[])))")

export CONFIG_JSON=$(cat << ENDJSON
{
  "MQTT_URL": "${MQTT_URL}",
  "MQTT_USER": "${MQTT_USER}",
  "MQTT_PASS": "${MQTT_PASS}",
  "YEMOT_PHONE_MAP": {},
  "CONTROLLERS": ${CONTROLLERS},
  "USERS": [
    {
      "name": "admin",
      "password": "${ADMIN_PASSWORD}",
      "role": "admin",
      "relays": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]
    }
  ],
  "EMERGENCY_PASSWORD": null
}
ENDJSON
)

export YEMOT_API_TOKEN
export YEMOT_API_LINK_URL
export PORT=3000

echo "🚀 מפעיל שרת בית חכם על פורט 3000..."
exec node /app/index.js
