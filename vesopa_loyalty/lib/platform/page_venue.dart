/// What the page the web app was served in says about its venue.
///
/// On a venue's own address (member.pontardawerfc.com) the app sits at `/`,
/// so the address names no venue. The server writes it into the page instead,
/// with the venue's colours where it has a look of its own
/// (vesopa_server/src/venue_looks.js):
///
///   <meta name="vesopa-venue" content="pontardawe-rfc">
///   <meta name="vesopa-look" content="#8F0000,#3F0000,#C41414">
///
/// Everything but the browser has no page, and answers null.
library;

export 'page_venue_io.dart' if (dart.library.js_interop) 'page_venue_web.dart';
