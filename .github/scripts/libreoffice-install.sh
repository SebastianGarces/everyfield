#!/bin/bash
set -euo pipefail
archives="$1"
packages=(libreoffice-writer libreoffice-calc)
apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o "Dir::Cache::Archives=$archives")
mkdir -p "$archives/partial"

install_cached() {
  compgen -G "$archives/*.deb" >/dev/null &&
    sudo apt-get install -y --no-install-recommends --no-download "${apt_opts[@]}" "$archives"/*.deb
}

fetch() {
  sudo timeout 60 apt-get update "${apt_opts[@]}" &&
    sudo timeout 150 apt-get install -y --no-install-recommends --download-only "${apt_opts[@]}" "${packages[@]}"
}

use_main_mirror() {
  local mirrors=/etc/apt/apt-mirrors.txt
  [ -f "$mirrors" ] || return 0
  sudo sed -i -E '/:\/\/[a-z0-9.-]+\.archive\.ubuntu\.com\//d' "$mirrors"
  grep -q '://archive\.ubuntu\.com/' "$mirrors" || echo 'http://archive.ubuntu.com/ubuntu/' | sudo tee -a "$mirrors" >/dev/null
}

if install_cached; then
  echo "LibreOffice from the cached archives, no mirror request"
  exit 0
fi
if fetch; then
  echo "LibreOffice downloaded from the runner's mirror"
else
  echo "The runner's Ubuntu mirror failed or was too slow; retrying on archive.ubuntu.com" >&2
  use_main_mirror
  fetch
fi
sudo apt-get install -y --no-install-recommends --no-download "${apt_opts[@]}" "${packages[@]}"
sudo chmod a+r "$archives"/*.deb
