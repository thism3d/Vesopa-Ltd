/// The venue a page was served for, when its address does not say.
///
/// A venue's own app host (member.pontardawerfc.com) is that one venue's app
/// at `/`, so there is no slug in the address; the server writes it into the
/// page instead (`<meta name="loyalty-venue">`, vesopa_server/src/loyalty_app.js),
/// with the venue's colours where it has a look of its own (`pageLook`).
library;

export 'page_venue_io.dart' if (dart.library.js_interop) 'page_venue_web.dart';
