#!/usr/bin/env bash
# Build TownCrier.app — a proper bundle (required for native notifications),
# assembled from the SPM executable, ad-hoc signed.
#   ./make-app.sh            → ./TownCrier.app
#   ./make-app.sh install    → also copies to /Applications and opens it
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release

APP=TownCrier.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/TownCrier "$APP/Contents/MacOS/TownCrier"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>ai.ogrady.towncrier</string>
  <key>CFBundleName</key><string>Town Crier</string>
  <key>CFBundleExecutable</key><string>TownCrier</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

codesign --force --sign - "$APP"
echo "Built $APP"

if [[ "${1:-}" == "install" ]]; then
  rm -rf /Applications/TownCrier.app
  cp -R "$APP" /Applications/
  open /Applications/TownCrier.app
  cat <<'HINT'
Installed + launched. Config (~/.config/crier/config, KEY=VALUE):
  CRIER_TOKEN=…    hub auth (legacy ~/.config/crier/token also works)
  NTFY_TOPIC=…     reserved ntfy topic — enables the live WebSocket
  NTFY_AUTH=tk_…   ntfy access token (reserved topics require it)
Menu bar 📯 → "Start at Login" to auto-launch.
HINT
fi
