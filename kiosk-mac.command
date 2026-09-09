#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a symlink
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE" # if $SOURCE was a relative symlink, we need to resolve it relative to the path where the symlink file was located
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

cd "$DIR"

node app.js &

URL="http://localhost:8080"
#FLAGS="--kiosk --incognito --no-first-run --disable-infobars"
FLAGS="--kiosk --noerrdialogs --disable-infobars --use-fake-ui-for-media-stream --no-first-run"

open -n -a "Google Chrome" --args "$FLAGS" "$URL"
