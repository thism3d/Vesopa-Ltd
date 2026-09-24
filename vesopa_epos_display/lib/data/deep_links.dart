/// How the Vesopa applications are addressed from outside themselves.
///
/// ONE SCHEME PER APPLICATION, IN REVERSE DNS
///
/// Each application answers on a web host, and its deep link is that host
/// turned inside out:
///
///     epos.vesopa.com      ->  com.vesopa.epos
///     display.vesopa.com   ->  com.vesopa.display
///     kitchen.vesopa.com   ->  com.vesopa.kitchen     (when there is one)
///
/// Reverse DNS because a URI scheme is a global namespace with no registry
/// behind it: `vesopa:` is a name anybody could take, and on a machine where
/// somebody already had, whichever application registered last would win and
/// the other would silently stop being reachable. A scheme derived from a
/// domain we own cannot collide with anyone.
///
/// The till keeps its old `vesopa:` scheme as well, and must: the Dojo checkout
/// window returns to it, and every terminal already commissioned expects it.
/// The reverse-DNS one is added beside it rather than in place of it.
///
/// WHERE THE REGISTRATION LIVES
///
/// In `msix_config.protocol_activation` in each application's pubspec.yaml —
/// that is what puts the scheme in the AppxManifest, which is what makes
/// Windows hand the URI over. Nothing in Dart can register a scheme; this file
/// only *reads* what arrives.
library;

import 'dart:io';

import 'package:url_launcher/url_launcher.dart';

/// This application's own scheme.
const displayScheme = 'com.vesopa.display';

/// The till's, for a link that opens it rather than this.
const tillScheme = 'com.vesopa.epos';

/// The kitchen screen's, reserved so the pattern is written down once rather
/// than re-decided when it is needed.
const kitchenScheme = 'com.vesopa.kitchen';

const displayHost = 'display.vesopa.com';
const tillHost = 'epos.vesopa.com';

/// This application's own Microsoft Store product id, from its pubspec.yaml.
///
/// Not used to install anything — it is already installed if this is running —
/// but kept here so the three ids live in one place per application rather than
/// only in a comment in a build config.
const displayStoreProductId = '9P8JCLQ5M3SQ';

/// Vesopa Kitchen, from `vesopa_epos_kitchen/pubspec.yaml`.
const kitchenStoreProductId = '9P29NN3R5PGS';

/// Vesopa EPOS, from Partner Center -> Product identity.
///
/// The till's own pubspec.yaml records its *package identity* (identity_name,
/// publisher, publisher_display_name) but not its product id — the two are
/// different things and one cannot be derived from the other. This is the id
/// from the listing at https://apps.microsoft.com/detail/9PDMNJXNFZCW.
const tillStoreProductId = '9PDMNJXNFZCW';

/// Where to send somebody whose PC has no till on it.
///
/// A product page when the id is known, and a Store *search* when it is not.
/// The search always resolves — it needs nothing but the name — so the button
/// on the setup card is never a dead end while the id is missing.
Uri tillStoreUri() => tillStoreProductId.isEmpty
    ? Uri.parse('ms-windows-store://search/?query=Vesopa%20EPOS')
    : Uri.parse('ms-windows-store://pdp/?productid=$tillStoreProductId');

/// The same listing on the web, for anything that is not the Store app —
/// a phone, a browser, or a machine with the Store removed.
Uri tillListingUri() => Uri.parse(
  'https://apps.microsoft.com/detail/$tillStoreProductId',
);

/// Open the Store at the till.
///
/// Returns whether Windows took it. False is worth showing: on a machine with
/// the Store removed — which is a real state on some managed tills — the button
/// does nothing, and saying so beats a button that appears broken.
///
/// Never throws. A customer display must not fall over because somebody pressed
/// a button on a setup card.
Future<bool> openTillInStore() async {
  try {
    return await launchUrl(tillStoreUri());
  } catch (_) {
    return false;
  }
}

/// Whether this application was started by following a link.
///
/// The runner passes the command line through to `main`, so a protocol
/// activation arrives as an argument that is a URI in our own scheme. Anything
/// else on the command line is ignored: this is a question about *how the user
/// got here*, not a general argument parser, and a screen facing the public is
/// not somewhere to grow one.
bool launchedByLink(List<String> args) {
  for (final arg in args) {
    final uri = Uri.tryParse(arg.trim());
    if (uri == null) continue;
    if (uri.scheme.toLowerCase() == displayScheme) return true;
  }
  return false;
}

/// A one-line description of how this machine can be reached, for the settings
/// screen. Windows only, because the scheme is registered by the MSIX manifest.
String? deepLinkHint() =>
    Platform.isWindows ? '$displayScheme:  ·  $displayHost' : null;
