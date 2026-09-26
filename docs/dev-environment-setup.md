# Setting up a Windows machine for this monorepo

Everything below is what is actually installed on the Vesopa build machine
(Windows Server 2025, `flutter doctor` clean on 2026-09-26), with the version it
is running. Install the same versions and the apps build without argument.

Commands are for **PowerShell as Administrator** unless it says otherwise. Where
a `winget` line is given, `winget` ships with Windows 11 and Server 2025.

## What you are setting up

| You want to work on | You need |
|---|---|
| The till, kitchen, display, express, loyalty apps (Flutter) | Flutter, Visual Studio C++ workload, JDK 21, Android SDK |
| The back office, auth, cloud, web (Node) | Node 22, Python (some build scripts) |
| Microsoft Store releases | Flutter + the `msix` tool + credentials from the owner |
| The live server | PuTTY (`plink`, `pscp`) + credentials from the owner |
| Browser testing and screenshots | Chrome, and `puppeteer-core` when a page needs driving |

## The essentials

### Git 2.55

```powershell
winget install --id Git.Git
```

Git Bash comes with it. Several scripts in this repo are `bash`, so keep it.

### Node 22.22.2, through nvm for Windows

The three Node apps pin the version in `.nvmrc` (`vesopa_server`,
`vesopa_web`, `vesopa_hosting`), and it is **v22.22.2**. Do not install Node
from nodejs.org — use nvm, because you will need to move between versions.

```powershell
winget install --id CoreyButler.NVMforWindows
nvm install 22.22.2
nvm use 22.22.2
node --version    # v22.22.2
```

On this machine nvm puts the active Node at `C:\nvm4w\nodejs`. In Git Bash that
is not always on the path; if `node` is not found, prepend it:

```bash
export PATH="/c/nvm4w/nodejs:$PATH"
```

### Python 3.14

```powershell
winget install --id Python.Python.3.14
```

Used by helper and one-off scripts, not by the apps at runtime. Tick "Add to
PATH" if you use the installer rather than winget.

### Flutter 3.47.5 stable (Dart 3.13.4 comes with it)

Do not install Dart separately.

```powershell
git clone https://github.com/flutter/flutter.git -b stable C:\Users\<you>\develop\flutter
# add C:\Users\<you>\develop\flutter\bin to PATH, then:
flutter --version
flutter doctor --android-licenses   # accept all
flutter doctor
```

The machine here keeps Flutter at `C:\Users\Administrator\develop\flutter`.

### Visual Studio 2026 Community — for Windows builds

The Flutter Windows build needs the C++ toolchain. Install the **"Desktop
development with C++"** workload; the rest is optional.

```powershell
winget install --id Microsoft.VisualStudio.Community --override `
  "--quiet --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended"
```

(The 2026 release is plain `Microsoft.VisualStudio.Community` — there is no
`.2026.` in the id, unlike 2019 and 2022.)

`flutter doctor` should then report *Visual Studio Community 2026*.

### Two JDKs: 21 for Android, and whatever is latest

Gradle for these apps wants **JDK 21**. A newer JDK is fine to have alongside —
this machine has Temurin 26 as well — but point Gradle at 21 if a build
complains about an unsupported class file or Gradle version.

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK
winget install --id EclipseAdoptium.Temurin.26.JDK   # optional
```

They land in `C:\Program Files\Eclipse Adoptium\`. To force Flutter's Gradle to
use 21:

```powershell
flutter config --jdk-dir "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
```

### Android SDK — command line tools are enough, Android Studio is optional

**Android Studio is not installed on this machine** and is not needed to build
or release. Install it only if you want its emulator manager or profiler.

```powershell
winget install --id Microsoft.OpenJDK.21          # if you skipped Temurin
winget install --id Google.AndroidStudio          # OPTIONAL
```

What is actually required is the SDK, which `sdkmanager` from the command line
tools installs. This machine has, under `%LOCALAPPDATA%\Android\Sdk`:

- `platforms`: android-34, android-35, android-36
- `build-tools`: 35.0.0, 36.0.0
- `ndk`: 27.0.12077973, 28.2.13676358
- `platform-tools` (adb 1.0.41), `cmake`, `cmdline-tools`

```powershell
# from the Sdk\cmdline-tools\latest\bin folder
.\sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;28.2.13676358"
.\sdkmanager --licenses
```

Then set `ANDROID_HOME` to `%LOCALAPPDATA%\Android\Sdk` and put
`platform-tools` on PATH so `adb` works.

### GitHub CLI 2.101

```powershell
winget install --id GitHub.cli
gh auth login --web          # device code; paste it at github.com/login/device
gh auth setup-git
```

The monorepo is **github.com/thism3d/Vesopa-Ltd**, default branch `main`.
Ask the owner for access. `main` is shared: push to it normally, and **never
force-push it**.

### PuTTY — for the live server

The deploy scripts and the SSH helpers here drive `plink` and `pscp`, not
OpenSSH.

```powershell
winget install --id PuTTY.PuTTY
```

The server address, root password and host key fingerprint come from the owner.
They live in a gitignored `.env.claude`, never in the repo.

### Chrome — Flutter web, and screenshots

```powershell
winget install --id Google.Chrome
```

`flutter doctor` needs it for the web target. For headless screenshots:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless --disable-gpu --screenshot=out.png --window-size=1280,900 https://example.com
```

For anything that needs clicking and typing, install `puppeteer-core` in a
scratch folder (not in the repo) and point it at that same Chrome:

```bash
npm init -y && npm install puppeteer-core
```

## Recommended as well — install these on day one

Neither is on the build machine yet, and both are wanted often enough that it is
worth having them before you need them.

```powershell
winget install --id Gyan.FFmpeg              # ffmpeg
winget install --id ImageMagick.ImageMagick  # the `magick` command
```

- **ffmpeg** — the Store listings take screenshots and short videos, and a phone
  or screen recording almost never arrives in the size, format or frame rate the
  Store accepts. ffmpeg trims, resizes and converts them. It is also the quickest
  way to turn a recording of a till session into something you can attach to a
  bug.

  ```bash
  ffmpeg -i recording.mp4 -vf scale=1366:768 -r 30 -t 30 store-clip.mp4
  ffmpeg -i clip.mov -vframes 1 -ss 3 shot.png      # one frame as a still
  ```

- **ImageMagick** — icons and listing images in bulk: resize a logo into every
  size the Store and the apps want, convert, crop, compare two screenshots.

  ```bash
  magick logo.png -resize 512x512 logo-512.png
  magick shot-*.png -append all-shots.png
  ```

## Also worth having

| Tool | Why | Install |
|---|---|---|
| scrcpy | shows an Android till or phone on your screen, over USB, and lets you click it — the easiest way to demonstrate or record the Android build | `winget install --id Genymobile.scrcpy` |
| jq | reading the JSON the back office and the Store API return | `winget install --id jqlang.jq` |
| 7-Zip | opening an `.msix` to check what actually went into a package | `winget install --id 7zip.7zip` |
| sqlite3 (3.50.6, already here) | reading a till's local database | `winget install --id SQLite.SQLite` |
| VS Code (1.138) | editor, with the Flutter and Dart extensions | `winget install --id Microsoft.VisualStudioCode` |
| MariaDB client | **not installed here.** The databases are reached over SSH on the server, not from this machine | — |

A note on names, because it has caused confusion: the image tool is
**ImageMagick** (`magick`). **Magisk** is an Android root utility — unrelated,
and not needed for any of this.

## Prove it works

```powershell
flutter doctor            # every line a tick, "No issues found!"
node --version            # v22.22.2
python --version          # 3.14.x
java -version             # 21 (or 26 with 21 also installed)
adb --version
gh auth status
```

Then build something small:

```bash
cd vesopa_server && npm install && npm test
cd ../vesopa_epos && flutter pub get && flutter build windows --debug
```

## Traps that have cost real time here

**A `build` folder copied from another machine stops the Windows build.**
CMake records the absolute path it was configured in, so a copied tree fails
with *"the current CMakeCache.txt directory ... is different"*. `build` is
generated — delete it and rebuild:

```bash
rm -rf vesopa_epos/build/windows
flutter build windows --debug
```

**Android builds ask for 8 GB of heap.** `vesopa_epos/android/gradle.properties`
and `vesopa_express/android/gradle.properties` set `-Xmx8G`. On a machine with
less RAM than that (this one has 7.8 GB and one CPU) the Dart step is killed
with no useful message. Either build Android on a bigger machine, or lower it
locally — `vesopa_epos_kitchen` runs happily at `-Xmx3G`. Do not commit the
lowered value.

**One CPU means slow.** A Windows debug build is about 80 seconds here; a
release build plus msix is far longer. Run builds in the background and expect
to wait.

**A Store release needs credentials you do not have yet.** See
`ms-store-submission-client/README.md`. The client ID and key live in that
folder's gitignored `.env`; ask the owner. The Store refuses a version it has
already accepted, so always run `node examples/whats-published.js` before
building.

**Secrets never go in the repo — it is public.** `.env`, `.env.claude`, the
Apple pass signing keys and `node_modules` are all gitignored. If you add a new
config file, check `git status` before committing.

## House rules

- Branch for your work; `main` is shared and is never force-pushed.
- `flutter doctor` clean before you report a build problem.
- Bump `version:` **and** `msix_version` together in a Flutter app's
  `pubspec.yaml` — a release with only one of them changed is rejected or, worse,
  accepted as the wrong version.
