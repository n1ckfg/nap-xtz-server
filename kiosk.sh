function chromium-kiosk() {
        #--incognito --kiosk --start-fullscreen --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland
        CMD="--kiosk --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland"
        chromium-browser $CMD $1
}

echo $XDG_SESSION_TYPE
chromium-kiosk "http://localhost:8080"

