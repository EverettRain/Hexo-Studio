#!/bin/bash
# README screenshots, drawn from fictional demo data without running the app.
#
#   app/scripts/readme-screenshots.sh [output folder]      (default: docs/images)
#
# macOS, with Google Chrome, Node and python3. demo.py makes a fictional anzhiyu blog and the
# data the interface shows (the network is needed the first time); the interface is built with a
# mock backend (readme/mock.ts) and opened in headless Chrome, one page per picture, with the
# window frame, traffic lights and shadow drawn around it on a transparent background. The editor's
# preview shows the demo blog as Hexo generated it. Your blogs and Hexo-Studio's data are never read.
# Environment: HS_DEMO (demo folder, default /tmp/hexo-studio-readme), CHROME (Chrome's executable).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/.." && pwd)
REPO=$(cd "$APP/.." && pwd)
DEMO=${HS_DEMO:-/tmp/hexo-studio-readme}
OUT=$(mkdir -p "${1:-$REPO/docs/images}" && cd "${1:-$REPO/docs/images}" && pwd)
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
BLOG_PORT=4610
UI_PORT=4611
SERVERS=()

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
cleanup() { for p in "${SERVERS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

[ -x "$CHROME" ] || fail "找不到 Chrome。可以用 CHROME=/path/to/chrome 指定。"
for p in $BLOG_PORT $UI_PORT; do
  ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || fail "端口 $p 已被占用。"
done

say "示例数据"
python3 "$HERE/readme/demo.py" "$DEMO"
say "构建界面（模拟后端）"
(cd "$APP" && node_modules/.bin/vite build --config scripts/readme/vite.config.mjs --outDir "$DEMO/ui")
cp "$DEMO/demo.json" "$DEMO/ui/"

python3 -m http.server $BLOG_PORT --bind 127.0.0.1 --directory "$DEMO/qingchuan-blog/public" >/dev/null 2>&1 & SERVERS+=($!)
python3 -m http.server $UI_PORT --bind 127.0.0.1 --directory "$DEMO/ui" >/dev/null 2>&1 & SERVERS+=($!)
sleep 1

# A 1100 × 720 window, 40 points of desktop around it for the shadow, at Retina scale.
shot() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$DEMO/chrome" \
    --default-background-color=00000000 --force-device-scale-factor=2 --window-size=1180,800 \
    --virtual-time-budget=${2:-8000} --screenshot="$OUT/$1.png" "http://127.0.0.1:$UI_PORT/index.html#$1" >/dev/null 2>&1
  say "  $1.png"
}

say "截图 → $OUT"
for s in welcome new-blog posts images config config-vscode source deploy settings; do shot "$s"; done
# The editor's preview loads the demo blog's page (and the theme's fonts and icons).
for s in editor-light editor-dark; do shot "$s" 20000; done
say "完成。示例数据在 $DEMO，可以删除。"
