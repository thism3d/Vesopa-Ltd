# vesopa_metric — Metric Membership

Metric Group's own membership app (white label, built by Vesopa). A member signs
in with **Continue with Vesopa**, registers their car registrations, and
Metric's ANPR barriers open for those cars. The server, camera integration and
staff console are in `../vesopa_metric_server` (see its README).

Same structure as `vesopa_loyalty`: Riverpod, one API client (`lib/data/api.dart`),
Continue with Vesopa copied from loyalty (`lib/platform/vesopa_sso*.dart`:
system browser + loopback on Windows/Android, in-app browser view on iPhone,
redirect on the web).

- Screens: sign-in, Membership card (status, member number and QR, cars),
  My cars (add/remove by registration), Visits (every barrier read), Account.
- Every tap and screen is sent to the server's activity log in batches
  (`lib/data/activity_log.dart`). Names only, never what was typed.
- Brand: `lib/brand.dart` and `assets/brand/`, from metricgroup.co.uk.
  `python tool/make_app_icons.py` redraws the launcher icons.

```bash
flutter run -d windows                      # talks to https://metric.vesopa.com
flutter run -d chrome --dart-define=METRIC_API=http://127.0.0.1:5085
flutter build web --release --no-web-resources-cdn   # served by the server
```

The Vesopa Auth client id comes from the server (`/api/v1/brand`), so builds
need no define. `--dart-define=VESOPA_METRIC_CLIENT_ID=...` pins it if wanted.
A Microsoft Store or app store listing needs Metric's own name reservation
(suggested "Metric Membership"). Add its `msix_config` identity to
pubspec.yaml when Partner Center has issued one.
