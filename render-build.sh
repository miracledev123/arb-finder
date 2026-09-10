#!/usr/bin/env bash
# Exit on error
set -o errexit

# Install Node dependencies
npm install

# Download Chrome binary into project cache folder
PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer npx puppeteer install chrome
