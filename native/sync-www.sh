#!/bin/sh
# Copy the PWA into the native wrapper's webDir. Run before every `npx cap sync`.
# The app ships its web assets bundled (Apple rejects thin remote-URL wrappers);
# sync/auth still talk to Supabase over the network exactly like the web app.
set -e
cd "$(dirname "$0")"
rm -rf www
mkdir -p www
cp ../index.html ../app.js ../config.js ../manifest.webmanifest ../sw.js www/
cp -R ../icons www/icons
echo "www/ refreshed from the repo root"
