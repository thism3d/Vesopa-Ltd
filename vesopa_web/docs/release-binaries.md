# public/app — release binaries

The two files the `/download` page links to live here **on the server only**:

| File | Served at |
|---|---|
| `VesopaEPOS Installer.exe` | `https://vesopaepos.com/app/VesopaEPOS%20Installer.exe` |
| `Vesopa EPOS.apk`          | `https://vesopaepos.com/app/Vesopa%20EPOS.apk`          |

The filenames contain a space, which is why the links are percent-encoded as
`%20`. Keep the names exactly as written above or the links break.

## They are not in this repo

`deploy.sh` excludes `public/app` from rsync. That exclude is load-bearing: the
sync runs with `--delete`, so without it every deploy would remove both
binaries from the server.

The flip side is that these files are **not** deployed for you. Upload them
directly:

```bash
scp "build/windows/VesopaEPOS Installer.exe" \
    root@3.72.113.21:/home/vesopa/web/vesopaepos.com/private/nodeapp/public/app/

scp "build/app/outputs/flutter-apk/Vesopa EPOS.apk" \
    root@3.72.113.21:/home/vesopa/web/vesopaepos.com/private/nodeapp/public/app/
```

Then check both actually serve:

```bash
curl -sI "https://vesopaepos.com/app/VesopaEPOS%20Installer.exe" | head -3
curl -sI "https://vesopaepos.com/app/Vesopa%20EPOS.apk"          | head -3
```

A `200` with a sane `content-length` is what you want. A `404` means the file is
not in this directory or the name does not match.

## Version

The "Download Now" button prints `APP_VERSION` from `src/config.js`, which is
independent of the Flutter app's own version in `vesopa_epos/pubspec.yaml`.
Bump it there when you upload a new installer, or the page will advertise the
wrong version.
