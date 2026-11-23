#!/usr/bin/env bash
set -euo pipefail

timeout --kill-after=10 480 node tools/ci/libreoffice.ts --arch "$1"

sudo mkdir -p /usr/local/share/fonts/everyfield
sudo cp packages/domain/src/documents/fonts/DMSans-{Regular,Medium,Bold}.ttf packages/domain/src/documents/fonts/DMSerifDisplay-Regular.ttf /usr/local/share/fonts/everyfield/
fc-cache -f
soffice --version
