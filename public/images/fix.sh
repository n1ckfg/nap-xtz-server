#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a symlink
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE" # if $SOURCE was a relative symlink, we need to resolve it relative to the path where the symlink file was located
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

cd "$DIR"

git mv output_20260222_181056.nap skeltn01.nap
git mv output_20260222_181107.nap skeltn02.nap
git mv output_20260222_181140.nap skeltn03.nap
git mv output_20260222_181154.nap skeltn04.nap
git mv output_20260222_181206.nap skeltn05.nap
git mv output_20260222_181218.nap skeltn06.nap
git mv output_20260222_181230.nap skeltn07.nap
git mv output_20260222_181244.nap skeltn08.nap
git mv output_20260222_181255.nap skeltn09.nap
git mv output_20260222_181306.nap skeltn10.nap
git mv output_20260222_181342.nap skeltn11.nap
git mv output_20260222_181349.nap skeltn12.nap
git mv output_20260222_181415.nap skeltn13.nap
git mv output_20260222_181426.nap skeltn14.nap
git mv output_20260222_181437.nap skeltn15.nap
git mv output_20260222_181451.nap skeltn16.nap
git mv output_20260222_181503.nap skeltn17.nap
git mv output_20260222_181517.nap skeltn18.nap
git mv output_20260222_181535.nap skeltn19.nap
git mv output_20260222_181549.nap skeltn20.nap
git mv output_20260222_181558.nap skeltn21.nap
git mv output_20260222_181604.nap skeltn22.nap
git mv output_20260222_181616.nap skeltn23.nap
git mv output_20260222_181624.nap skeltn24.nap
git mv output_20260222_181655.nap skeltn25.nap
git mv output_20260222_181704.nap skeltn26.nap
git mv output_20260222_181715.nap skeltn27.nap
git mv output_20260222_181729.nap skeltn28.nap
git mv output_20260222_181744.nap skeltn29.nap
git mv output_20260222_181752.nap skeltn30.nap
git mv output_20260222_181758.nap skeltn31.nap
git mv output_20260222_181804.nap skeltn32.nap
git mv output_20260222_181811.nap skeltn33.nap
git mv output_20260222_181820.nap skeltn34.nap
git mv output_20260222_181839.nap skeltn35.nap
git mv output_20260222_181850.nap skeltn36.nap
git mv output_20260222_181903.nap skeltn37.nap
git mv output_20260222_181932.nap skeltn38.nap
git mv output_20260222_181940.nap skeltn39.nap
git mv output_20260222_181957.nap skeltn40.nap
git mv output_20260222_182008.nap skeltn41.nap
git mv output_20260222_182017.nap skeltn42.nap
git mv output_20260222_182028.nap skeltn43.nap
git mv output_20260222_182034.nap skeltn44.nap
git mv output_20260222_182040.nap skeltn45.nap
git mv output_20260222_182051.nap skeltn46.nap
