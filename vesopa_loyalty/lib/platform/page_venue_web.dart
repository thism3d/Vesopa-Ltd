import 'package:web/web.dart' as web;

/// The `<meta name="loyalty-venue">` the server wrote into this page.
String? pageVenue() {
  final meta = web.document.querySelector('meta[name="loyalty-venue"]');
  final slug = meta?.getAttribute('content')?.trim() ?? '';
  return slug.isEmpty ? null : slug;
}

/// The club, deep and bright colours (`#RRGGBB`) the server wrote into the
/// page for a venue with a look of its own (vesopa_server/src/venue_looks.js),
/// as `<meta name="vesopa-look">`; null for every other venue.
List<String>? pageLook() {
  final value = web.document.querySelector('meta[name="vesopa-look"]')?.getAttribute('content');
  final parts = value?.split(',').map((s) => s.trim()).toList();
  if (parts == null || parts.length != 3) return null;
  final hex = RegExp(r'^#[0-9a-fA-F]{6}$');
  return parts.every(hex.hasMatch) ? parts : null;
}
