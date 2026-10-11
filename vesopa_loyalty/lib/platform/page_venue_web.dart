import 'package:web/web.dart' as web;

String? _meta(String name) {
  final value = web.document.querySelector('meta[name="$name"]')?.getAttribute('content')?.trim();
  return value == null || value.isEmpty ? null : value;
}

/// The venue the server wrote into the page, or null.
String? pageVenue() => _meta('vesopa-venue');

/// The venue's club, deep and bright colours as `#RRGGBB`, or null.
List<String>? pageLook() {
  final parts = _meta('vesopa-look')?.split(',').map((s) => s.trim()).toList();
  if (parts == null || parts.length != 3) return null;
  final hex = RegExp(r'^#[0-9a-fA-F]{6}$');
  return parts.every(hex.hasMatch) ? parts : null;
}
