/// The venue's screens finding each other on the Wi-Fi by themselves (owner,
/// 2026-11-27: "use the hardware ... use local connection to find out the
/// TV"): DNS-SD / Bonjour through each platform's own service (Android
/// NsdManager, GoNsd.kt; iOS NetServiceBrowser, AppDelegate.swift).
///
/// A TV running Kitchen or Customer display announces `_vesopago._tcp` with
/// the port of its little server and its device id ([advertise]); a phone or
/// tablet browses ([discover]) and is told each one's address as it appears.
/// Nothing secret is announced: the key a phone needs to press keys still
/// comes from Vesopa's list of screens (lib/remote/remote_link.dart).
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class NsdScreen {
  const NsdScreen({required this.id, required this.name, required this.mode, required this.host, required this.port});
  final String id;
  final String name;
  final String mode;
  final String host;
  final int port;
}

class GoNsd {
  GoNsd._();

  static const _channel = MethodChannel('com.vesopa.go/nsd');
  static void Function(NsdScreen)? _onFound;
  static void Function(String line)? onLog;
  static bool _wired = false;
  static String? _advertised;

  static void _wire() {
    if (_wired) return;
    _wired = true;
    _channel.setMethodCallHandler((call) async {
      final a = call.arguments is Map ? Map<String, dynamic>.from(call.arguments as Map) : const <String, dynamic>{};
      switch (call.method) {
        case 'found':
          final port = a['port'] is num ? (a['port'] as num).toInt() : 0;
          final host = '${a['host'] ?? ''}';
          final id = '${a['id'] ?? ''}';
          if (host.isEmpty || port <= 0 || id.isEmpty) return null;
          debugPrint('go.nsd: found ${a['name']} ($id) at $host:$port');
          _onFound?.call(NsdScreen(id: id, name: '${a['name'] ?? ''}', mode: '${a['mode'] ?? ''}', host: host, port: port));
        case 'log':
          debugPrint('go.nsd: ${a['line']}');
          onLog?.call('${a['line']}');
      }
      return null;
    });
  }

  /// This screen on the Wi-Fi, under its device id. Again only when something
  /// changed (its name, mode or port).
  static Future<void> advertise({required String id, required String name, required String mode, required int port}) async {
    final sig = '$id|$name|$mode|$port';
    if (_advertised == sig) return;
    _wire();
    try {
      final ok = await _channel.invokeMethod<bool>('register', {'id': id, 'name': name, 'mode': mode, 'port': port});
      if (ok == true) _advertised = sig;
    } catch (e) {
      debugPrint('go.nsd: announce not available: $e');
    }
  }

  /// Look for the venue's screens on this Wi-Fi; [onFound] for each.
  static Future<bool> discover(void Function(NsdScreen) onFound) async {
    _wire();
    _onFound = onFound;
    try {
      return await _channel.invokeMethod<bool>('discover') ?? false;
    } catch (e) {
      debugPrint('go.nsd: search not available: $e');
      return false;
    }
  }
}
