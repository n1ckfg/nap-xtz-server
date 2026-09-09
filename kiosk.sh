function chromium-kiosk() {
        #--incognito --kiosk --start-fullscreen --use-fake-ui-for-media-stream --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland
        CMD="--kiosk --noerrdialogs --disable-infobars --use-fake-ui-for-media-stream --no-first-run --ozone-platform=wayland"
        chromium-browser $CMD $1
}

echo $XDG_SESSION_TYPE
node app.js &
chromium-kiosk "http://localhost:8080"

