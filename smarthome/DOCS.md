# Smart Home Jewish — Add-on

ממשק בקרה לבית חכם עם תיזמון עברי, תמיכה בבקרי Tasmota, התקני Home Assistant, ומענה טלפוני (ימות המשיח).

## התקנה
1. ב-HA לך ל: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. הוסף את כתובת ה-GitHub של ה-repo
3. חפש **"Smart Home Jewish"** והתקן
4. הגדר ב-**Configuration** (ראה להלן)
5. לחץ **Start**
6. פתח בדפדפן: `http://homeassistant.local:3000`

## הגדרות

| שדה | תיאור | דוגמה |
|-----|-------|-------|
| `mqtt_url` | כתובת Mosquitto | `mqtt://172.30.33.0:1883` |
| `mqtt_user` | משתמש MQTT (משתמש HA רגיל) | `myuser` |
| `mqtt_pass` | סיסמת MQTT | `mypassword` |
| `admin_password` | סיסמת כניסה לממשק | `mysecret` |
| `yemot_api_token` | טוקן ימות המשיח (אופציונלי) | |
| `yemot_api_link_url` | כתובת webhook לימות (אופציונלי) | |

## הגדרת בקרים
```yaml
controllers:
  - id: main
    name: "בית"
    topic: tasmota_XXXXXX
    relay_count: 6
  - id: second
    name: "קומה שנייה"
    topic: tasmota_YYYYYY
    relay_count: 8
```
הטופיק (`topic`) הוא שם ה-MQTT של הבקר — ניתן למצוא ב-Tasmota תחת **Configuration → MQTT**.

## הוספת התקני Home Assistant
לאחר ההפעלה, כנס לכרטיסיית **"🏠 התקנים"** בממשק:
1. הזן כתובת HA וצור **Long-Lived Access Token** ב-HA (Settings → שם פרופיל → Long-Lived Access Tokens)
2. לחץ **"רענן"** — תופיע רשימת כל ה-switch/light/fan
3. סמן את הרצויים ולחץ **"הוסף נבחרים"**
4. ההתקנים מופיעים ברשימת הממסרים וניתנים לתיזמון
