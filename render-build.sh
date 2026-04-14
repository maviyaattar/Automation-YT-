#!/usr/bin/env bash
set -e

apt-get update
apt-get install -y imagemagick
which magick || true
which convert || true
