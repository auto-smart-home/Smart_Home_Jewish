# עוטף את התמונה-הקיימת (whisper-asr-webservice) ב-run.sh משלנו, כדי לקרוא את ההגדרות
# (גודל-מודל/מנוע) מ-/data/options.json של ה-add-on — בדיוק באותו עקרון כמו run.sh של
# Smart Home Jewish עצמו (yemot_api_token וכו'), ולא דורש בניה-עצמית של שרת-whisper.
# התמונה-הזו היא multi-arch (amd64 + arm64) — ה-FROM יבחר אוטומטית את הפלטפורמה הנכונה
# בזמן-הבנייה על המכונה של Home Assistant.
FROM onerahmet/openai-whisper-asr-webservice:latest

# jq לקריאת /data/options.json — לא קיים בתמונת-הבסיס כברירת-מחדל.
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT ["/run.sh"]
