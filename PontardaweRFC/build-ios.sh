#!/usr/bin/env bash
# Pontardawe RFC for iPhone (with its Apple Watch app), on a Mac.
#
# From the repository root:
#
#   bash PontardaweRFC/build-ios.sh
#
# Makes the project, builds it, and opens the archive in Xcode's Organizer,
# where "Distribute App" > App Store Connect uploads it. The version and build
# number are venue.json's: raise "build" for every upload.
#
# Needs, once: Flutter, Xcode signed in to the Vesopa team (G238FR2ZC9), and
# CocoaPods. The first time, see PontardaweRFC/README.md "iPhone" for the App
# Store Connect record.
set -euo pipefail

venue_dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$venue_dir")"

python3 "$repo/vesopa_loyalty/tool/make_venue_app.py" "$venue_dir"

cd "$venue_dir/build/app"
flutter pub get
flutter build ipa --release --dart-define-from-file=venue_defines.json

open build/ios/archive/Runner.xcarchive
echo "Archive open in Xcode: Distribute App > App Store Connect > Upload."
