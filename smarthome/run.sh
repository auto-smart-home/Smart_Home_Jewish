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

# ── עדכון אוטומטי מ-GitHub בכל הפעלה — עמיד-בפני-כשל-רשת ──────────────────────
# בעיה שהתגלתה בפועל: מיד אחרי הפסקת-חשמל, ה-add-on עולה (boot: auto עובד נכון), אבל
# האינטרנט-בפועל (הראוטר) עוד לא התחבר-מחדש כשה-wget רץ. wget -O כותב *ישירות* לקובץ-
# היעד תוך-כדי ההורדה — אם ההורדה נכשלת-באמצע, היא משאירה קובץ-חלקי/ריק *במקום* הגרסה-
# הטובה-שהייתה-שם, והשרת ממשיך לרוץ על הקובץ השבור הזה (כי set -e לא נתפס, בגלל ה-||).
# התיקון: מורידים לקובץ-זמני, מוודאים שההורדה הצליחה *וגם* שהקובץ סביר-בגודלו (לא-ריק/
# חלקי), ורק-אז מחליפים את הקובץ-האמיתי. אם זה נכשל אחרי כמה נסיונות — משאירים את מה
# שכבר יש בדיסק (עדיף גרסה-ישנה-אבל-תקינה על פני גרסה-חדשה-אבל-שבורה), וממשיכים להפעיל.
download_with_retry() {
  target="$1"
  url="$2"
  min_size="$3"
  tmp="${target}.tmp"
  attempt=1
  max_attempts=5
  while [ $attempt -le $max_attempts ]; do
    if wget -q -O "$tmp" "$url" 2>/dev/null; then
      actual_size=$(wc -c < "$tmp" 2>/dev/null || echo 0)
      if [ "$actual_size" -ge "$min_size" ]; then
        mv "$tmp" "$target"
        echo "✅ $(basename "$target") עודכן (${actual_size} bytes, נסיון ${attempt})"
        return 0
      else
        echo "⚠️ $(basename "$target") הורד אבל קטן-מדי (${actual_size} bytes < ${min_size}) — כנראה הורדה-חלקית, מנסה שוב..."
      fi
    else
      echo "⚠️ $(basename "$target") נכשל בהורדה (נסיון ${attempt}/${max_attempts})"
    fi
    rm -f "$tmp"
    attempt=$((attempt + 1))
    [ $attempt -le $max_attempts ] && sleep 3
  done
  echo "❌ $(basename "$target") — כל הנסיונות נכשלו, נשארים עם הגרסה-הקיימת-בדיסק (לא מוחלפת בקובץ-שבור)"
  return 1
}

if [ -n "$GITHUB_REPO" ]; then
  BASE_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/main/smarthome"
  echo "🔄 מוריד קבצים עדכניים מ-GitHub: ${GITHUB_REPO}..."
  TS=$(date +%s)
  # min_size: סף-סביר-לזיהוי-הורדה-חלקית — הקבצים האמיתיים גדולים בהרבה (מאות-KB), אז
  # אפילו סף-נמוך-יחסית (10KB) מספיק כדי לתפוס "כמעט-ריק"/"אמצע-הורדה-שנקטעה".
  download_with_retry /app/smart_home_v3.html "${BASE_URL}/smart_home_v3.html?ts=${TS}" 10000
  download_with_retry /app/index.js "${BASE_URL}/index.js?ts=${TS}" 5000
fi

echo "🚀 מפעיל שרת בית חכם..."
exec node /app/index.js
