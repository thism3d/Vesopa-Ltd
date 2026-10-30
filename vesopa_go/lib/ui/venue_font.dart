/// The venue's lettering on Go, as the till letters itself (vesopa_epos
/// lib/data/fonts.dart): the family chosen in the back office (Till settings,
/// Lettering), its faces fetched from /api/till/fonts and registered with
/// Flutter, then the whole app drawn in it. Nothing chosen, or offline: the
/// device's own font.
library;

import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../config/constants.dart' show apiBase;
import '../data/session.dart';

final _loaded = <String, String>{};

/// The venue's font family once it is ready to draw, else null.
final venueFontProvider = FutureProvider<String?>((ref) async {
  final slug = ref.watch(tapProvider.select((s) => s.config.fontSlug)).toLowerCase();
  final office = ref.watch(tapProvider.select((s) => s.venue?.office));
  if (slug.isEmpty || office == null || office.isEmpty) return null;
  final done = _loaded[slug];
  if (done != null) return done;
  try {
    final res = await http
        .get(Uri.parse('$apiBase/api/till/fonts?office=${Uri.encodeQueryComponent(office)}'))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) return null;
    final fonts = ((jsonDecode(utf8.decode(res.bodyBytes)) as Map)['fonts'] as List?) ?? const [];
    for (final f in fonts) {
      if (f is! Map || '${f['slug']}'.toLowerCase() != slug) continue;
      final family = '${f['family']}';
      final loader = FontLoader(family);
      var faces = 0;
      for (final face in (f['faces'] as List? ?? const [])) {
        final url = '${(face as Map)['url'] ?? ''}';
        if (url.isEmpty) continue;
        final full = url.startsWith('http') ? url : '$apiBase${url.startsWith('/') ? '' : '/'}$url';
        final bytes = await http.get(Uri.parse(full)).timeout(const Duration(seconds: 20));
        if (bytes.statusCode != 200) continue;
        loader.addFont(Future.value(ByteData.view(Uint8List.fromList(bytes.bodyBytes).buffer)));
        faces++;
      }
      if (faces == 0) return null;
      await loader.load();
      return _loaded[slug] = family;
    }
  } catch (_) {}
  return null;
});
