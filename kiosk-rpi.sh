#--incognito --kiosk --start-fullscreen --use-fake-ui-for-media-stream --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland

APP_PATH="chromium-browser"
CMD="--kiosk --noerrdialogs --disable-infobars --use-fake-ui-for-media-stream --no-first-run --ozone-platform=wayland"

echo $XDG_SESSION_TYPE
node app.js &
$APP_PATH $CMD "http://localhost:8080"

