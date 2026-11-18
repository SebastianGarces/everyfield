#!/usr/bin/env bash
set -euo pipefail

debs="$HOME/libreoffice-debs"
mkdir -p "$debs/partial"
apt_cache=(-o "Dir::Cache::Archives=$debs" -o APT::Keep-Downloaded-Packages=true -o APT::Sandbox::User=root)
echo "Restored $(find "$debs" -maxdepth 1 -name '*.deb' | wc -l) cached packages."
sudo apt-get update
sudo apt-get install -y --no-install-recommends "${apt_cache[@]}" libreoffice-writer libreoffice-calc
sudo apt-get "${apt_cache[@]}" autoclean
sudo rm -rf "$debs/partial" "$debs/lock"
sudo chown -R "$(id -u):$(id -g)" "$debs"
echo "Caching $(find "$debs" -maxdepth 1 -name '*.deb' | wc -l) packages, $(du -sh "$debs" | cut -f1)."

sudo mkdir -p /usr/local/share/fonts/everyfield
sudo cp packages/domain/src/documents/fonts/DMSans-{Regular,Medium,Bold}.ttf packages/domain/src/documents/fonts/DMSerifDisplay-Regular.ttf /usr/local/share/fonts/everyfield/
fc-cache -f
soffice --version
