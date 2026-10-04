#!/bin/sh
set -e

OPTIONS="/data/options.json"

ASR_MODEL=$(jq -r '.asr_model // "small"' "$OPTIONS")
ASR_ENGINE=$(jq -r '.asr_engine // "faster_whisper"' "$OPTIONS")
export ASR_MODEL
export ASR_ENGINE

echo "🎙️ מפעיל Whisper ASR (model=${ASR_MODEL}, engine=${ASR_ENGINE})..."
echo "   טעינת-המודל-הראשונה (בעיקר small/medium) יכולה לקחת כמה דקות — זה תקין."

# whisper-asr-webservice הוא ה-entrypoint המקורי של תמונת-הבסיס (console-script) —
# מריצים אותו ישירות (exec, לא כתהליך-משנה) כדי שסיגנלי Stop/Restart מה-Supervisor
# יגיעו-אליו ישירות, בדיוק כמו run.sh הרגיל של Smart Home Jewish.
exec whisper-asr-webservice
