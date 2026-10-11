import 'package:web/web.dart' as web;

/// The `<meta name="loyalty-venue">` the server wrote into this page.
String? pageVenue() {
  final meta = web.document.querySelector('meta[name="loyalty-venue"]');
  final slug = meta?.getAttribute('content')?.trim() ?? '';
  return slug.isEmpty ? null : slug;
}
