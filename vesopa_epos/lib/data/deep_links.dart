/// How the Vesopa applications are addressed from outside themselves, and how
/// this one sends somebody to install the others.
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
/// behind it. `vesopa:` is a name anybody could take, and on a machine where
/// somebody already had, whichever application registered last would win and
/// the other would silently stop being reachable. A scheme derived from a
/// domain we own cannot collide with anyone.
///
/// **This till keeps `vesopa:` as well, and must.** The Dojo checkout window
/// returns to it and every terminal already commissioned expects it, so the
/// reverse-DNS scheme is registered beside it rather than in place of it — see
/// `protocol_activation` in pubspec.yaml, which is what actually puts both in
/// the AppxManifest. Nothing in Dart can register a scheme.
///
/// THE STORE IDS ARE NOT GUESSES
///
/// Each is copied from the application it belongs to. Getting one wrong sends
/// somebody to a Store page for the wrong product, which is worse than sending
/// them to a search — so an id that is not known here is left empty and the
/// search is used instead.
library;

import 'package:url_launcher/url_launcher.dart';

/// This till's own schemes. The first is historic and load-bearing; see above.
const tillLegacyScheme = 'vesopa';
const tillScheme = 'com.vesopa.epos';

const displayScheme = 'com.vesopa.display';
const kitchenScheme = 'com.vesopa.kitchen';

const tillHost = 'epos.vesopa.com';
const displayHost = 'display.vesopa.com';
const kitchenHost = 'kitchen.vesopa.com';

/// This till itself, from Partner Center -> Product identity.
/// https://apps.microsoft.com/detail/9PDMNJXNFZCW
const tillStoreProductId = '9PDMNJXNFZCW';

/// Vesopa Customer Display, from `vesopa_epos_display/pubspec.yaml`.
const displayStoreProductId = '9P8JCLQ5M3SQ';

/// Vesopa Kitchen, from `vesopa_epos_kitchen/pubspec.yaml`.
const kitchenStoreProductId = '9P29NN3R5PGS';

/// A Store link for a product, or a search when its id is not known.
///
/// The search always resolves — it needs nothing but a name — so a missing id
/// costs one extra tap rather than a dead button.
Uri storeUriFor(String productId, {required String searchFor}) =>
    productId.isEmpty
    ? Uri.parse('ms-windows-store://search/?query=${Uri.encodeComponent(searchFor)}')
    : Uri.parse('ms-windows-store://pdp/?productid=$productId');

/// Open the Store at the customer display.
///
/// Returns whether Windows took it. False is worth showing rather than
/// swallowing: on a managed till with the Store removed — which is a real state
/// — the button does nothing, and a button that appears broken is worse than
/// one that explains itself.
///
/// Never throws. Nothing on a settings page may take the till down.
Future<bool> openDisplayInStore() => _open(
  storeUriFor(displayStoreProductId, searchFor: 'Vesopa Customer Display'),
);

/// Open the Store at the kitchen screen.
Future<bool> openKitchenInStore() =>
    _open(storeUriFor(kitchenStoreProductId, searchFor: 'Vesopa Kitchen'));

Future<bool> _open(Uri uri) async {
  try {
    return await launchUrl(uri);
  } catch (_) {
    return false;
  }
}
