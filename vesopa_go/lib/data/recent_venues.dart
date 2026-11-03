/// The venues this phone has been signed in to, newest first, for the
/// welcome screen's "Sign in again" and More's "Switch venue or account".
///
/// Only a name and a logo address are kept: never a token. Signing back in
/// to one is a fresh Continue with Vesopa, with Vesopa's account picker, so
/// the person chooses which Vesopa account; the licence seat is taken again
/// the usual way (sign_in_flow.dart).
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class RecentVenue {
  const RecentVenue({required this.name, this.markUrl, required this.at});
  final String name;
  final String? markUrl;
  final DateTime at;

  Map<String, dynamic> toJson() => {'name': name, 'mark': markUrl, 'at': at.toIso8601String()};
  static RecentVenue? fromJson(Object? j) {
    if (j is! Map) return null;
    final name = '${j['name'] ?? ''}'.trim();
    if (name.isEmpty) return null;
    return RecentVenue(
      name: name,
      markUrl: (j['mark'] as String?)?.trim().isEmpty ?? true ? null : j['mark'] as String,
      at: DateTime.tryParse('${j['at']}') ?? DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

class RecentVenues {
  static const _key = 'vesopa_go_recent_venues';
  static const _max = 6;

  /// Set by More's "Switch venue or account": the welcome screen opens
  /// Vesopa's account picker straight away instead of waiting for a press.
  static bool switchOnOpen = false;

  static Future<List<RecentVenue>> load() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null) return const [];
      final list = (jsonDecode(raw) as List).map(RecentVenue.fromJson).whereType<RecentVenue>().toList();
      list.sort((a, b) => b.at.compareTo(a.at));
      return list;
    } catch (_) {
      return const [];
    }
  }

  static Future<void> remember(String name, String? markUrl) async {
    if (name.trim().isEmpty) return;
    try {
      final list = [...await load()]..removeWhere((v) => v.name == name);
      list.insert(0, RecentVenue(name: name, markUrl: markUrl, at: DateTime.now()));
      await (await SharedPreferences.getInstance())
          .setString(_key, jsonEncode([for (final v in list.take(_max)) v.toJson()]));
    } catch (_) {}
  }

  static Future<void> forget(String name) async {
    try {
      final list = [...await load()]..removeWhere((v) => v.name == name);
      await (await SharedPreferences.getInstance()).setString(_key, jsonEncode([for (final v in list) v.toJson()]));
    } catch (_) {}
  }
}
