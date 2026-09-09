#!/bin/bash
# Kiosk launcher for macOS — double-click in Finder.
# Starts the server, waits for it to listen, then opens Chrome fullscreen on
# the drawing page. Quitting the browser (cmd-Q) also stops the server.
# Linux/Raspberry Pi equivalent: kiosk-rpi.sh

set -u

# Finder starts scripts in $HOME, so move to the folder this file lives in.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a symlink
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
cd "$DIR"

PORT="${PORT_HTTP:-8080}"
URL="http://localhost:$PORT"

# A double-clicked .command gets a bare PATH — no Homebrew, no nvm.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
    for candidate in "$HOME/.nvm/versions/node"/*/bin; do
        if [ -x "$candidate/node" ]; then export PATH="$candidate:$PATH"; break; fi
    done
fi
if ! command -v node >/dev/null 2>&1; then
    echo "node not found. Install Node.js (nodejs.org, or: brew install node),"
    echo "then run setup.command once to install this project's dependencies."
    read -r -p "Press return to close. "
    exit 1
fi

# Any Chromium-family browser will do; Chrome first.
BROWSER=""
for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    if [ -x "$candidate" ]; then BROWSER="$candidate"; break; fi
done
if [ -z "$BROWSER" ]; then
    echo "No Chromium-based browser found in /Applications."
    echo "Install Google Chrome, or open $URL by hand."
    read -r -p "Press return to close. "
    exit 1
fi

# Its own profile, for two reasons: a running Chrome would otherwise just open
# a tab and drop every flag below, and the camera permission granted by
# --use-fake-ui-for-media-stream is remembered here between runs.
PROFILE="$HOME/Library/Application Support/nap-xtz-kiosk"

# --incognito --start-fullscreen --ozone-platform=wayland (Linux) are also options.
FLAGS="--kiosk --noerrdialogs --disable-infobars --no-first-run \
--use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
--disable-session-crashed-bubble"

# Reuse a server that is already up (say, one started from run.command);
# otherwise start one here and take it down again on the way out.
SERVER_PID=""
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Server already listening on port $PORT — using it."
else
    node app.js &
    SERVER_PID=$!
    trap 'if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; fi' EXIT
fi

# Wait for it to accept connections, so the kiosk never lands on an error page.
for _ in $(seq 1 100); do
    if nc -z localhost "$PORT" >/dev/null 2>&1; then break; fi
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo
        echo "The server exited during startup — see the log above."
        echo "A port already in use is the usual cause; app.js listens on 8080, 4321 and 8090."
        read -r -p "Press return to close. "
        exit 1
    fi
    sleep 0.2
done

# macOS asks once, per browser, for camera access; that prompt is the system's
# and has to be accepted by hand. The in-page prompt is what the flag suppresses.
echo "Opening $URL in kiosk mode. cmd-Q quits; 'h' shows the page's controls."
"$BROWSER" $FLAGS --user-data-dir="$PROFILE" "$URL"
