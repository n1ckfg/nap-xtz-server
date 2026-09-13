#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a symlink
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE" # if $SOURCE was a relative symlink, we need to resolve it relative to the path where the symlink file was located
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

cd "$DIR"

git mv output_20260222_181056.nap skelton00.nap
git mv output_20260222_181107.nap skelton00.nap
git mv output_20260222_181140.nap skelton00.nap
git mv output_20260222_181154.nap skelton00.nap
git mv output_20260222_181206.nap skelton00.nap
git mv output_20260222_181218.nap skelton00.nap
git mv output_20260222_181230.nap skelton00.nap
git mv output_20260222_181244.nap skelton00.nap
git mv output_20260222_181255.nap skelton00.nap
git mv output_20260222_181306.nap skelton00.nap
git mv output_20260222_181342.nap skelton00.nap
git mv output_20260222_181349.nap skelton00.nap
git mv output_20260222_181415.nap skelton00.nap
git mv output_20260222_181426.nap skelton00.nap
git mv output_20260222_181437.nap skelton00.nap
git mv output_20260222_181451.nap skelton00.nap
git mv output_20260222_181503.nap skelton00.nap
git mv output_20260222_181517.nap skelton00.nap
git mv output_20260222_181535.nap skelton00.nap
git mv output_20260222_181549.nap skelton00.nap
git mv output_20260222_181558.nap skelton00.nap
git mv output_20260222_181604.nap skelton00.nap
git mv output_20260222_181616.nap skelton00.nap
git mv output_20260222_181624.nap skelton00.nap
git mv output_20260222_181655.nap skelton00.nap
git mv output_20260222_181704.nap skelton00.nap
git mv output_20260222_181715.nap skelton00.nap
git mv output_20260222_181729.nap skelton00.nap
git mv output_20260222_181744.nap skelton00.nap
git mv output_20260222_181752.nap skelton00.nap
git mv output_20260222_181758.nap skelton00.nap
git mv output_20260222_181804.nap skelton00.nap
git mv output_20260222_181811.nap skelton00.nap
git mv output_20260222_181820.nap skelton00.nap
git mv output_20260222_181839.nap skelton00.nap
git mv output_20260222_181850.nap skelton00.nap
git mv output_20260222_181903.nap skelton00.nap
git mv output_20260222_181932.nap skelton00.nap
git mv output_20260222_181940.nap skelton00.nap
git mv output_20260222_181957.nap skelton00.nap
git mv output_20260222_182008.nap skelton00.nap
git mv output_20260222_182017.nap skelton00.nap
git mv output_20260222_182028.nap skelton00.nap
git mv output_20260222_182034.nap skelton00.nap
git mv output_20260222_182040.nap skelton00.nap
git mv output_20260222_182051.nap skelton00.nap