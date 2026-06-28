#!/usr/bin/with-contenv bashio

# קרא הגדרות מ-HA Add-on options
MQTT_URL=$(bashio::config 'mqtt_url')
MQTT_USER=$(bashio::config 'mqtt_user')
MQTT_PASS=$(bashio::config 'mqtt_pass')
YEMOT_API_TOKEN=$(bashio::config 'yemot_api_token')
YEMOT_API_LINK_URL=$(bashio::config 'yemot_api_link_url')
ADMIN_PASSWORD=$(bashio::config 'admin_password')

# בנה CONFIG_JSON מה-options
CONTROLLERS=$(bashio::config 'controllers')

CONFIG_JSON=$(cat << ENDJSON
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

export CONFIG_JSON
export YEMOT_API_TOKEN
export YEMOT_API_LINK_URL
export PORT=3000

bashio::log.info "מפעיל שרת בית חכם..."
exec node /app/index.js
