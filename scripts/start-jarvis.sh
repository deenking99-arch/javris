#!/usr/bin/env bash
# JARVIS 2.0 – Start unter macOS/Linux (macOS-Autostart: Systemeinstellungen → Allgemein → Anmeldeobjekte)
cd "$(dirname "$0")/.." || exit 1
[ -f client/dist/index.html ] || npm run build
npm start &
sleep 4
URL=http://127.0.0.1:7777
FLAGS="--app=$URL --autoplay-policy=no-user-gesture-required --start-fullscreen"
if [ "$(uname)" = "Darwin" ]; then
  open -na "Google Chrome" --args $FLAGS
else
  (google-chrome $FLAGS || chromium $FLAGS || xdg-open "$URL") >/dev/null 2>&1 &
fi
wait
