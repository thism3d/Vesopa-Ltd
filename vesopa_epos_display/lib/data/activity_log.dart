/// The Vesopa activity log, app side: what was pressed, which screens were
/// opened, who signed in and what went wrong, sent to the server so a fault
/// can be traced without ringing the venue.
///
/// ONE FILE, EVERY APP
///
/// The canonical copy is `shared/activity-log/activity_log.dart`.
/// `tool/sync-activity-log.sh` copies it into each app as
/// `lib/data/activity_log.dart`. Edit the shared copy, then sync.
///
/// WHERE IT GOES
///
///   * a local file, `activity-YYYY-MM-DD.jsonl`, kept 14 days, always. The
///     customer display has no network at all, so this is its only log.
///   * `POST <apiBase>/activity/v1/events` with the app's own token, in batches every
///     twenty seconds. The server decides the venue from the token and shows
///     the lines in the back office under Activity Log.
///
/// NEVER IN THE WAY. Every method swallows its own failures. A log that can
/// stop a sale is worse than no log.
///
/// NOTHING SECRET. Taps record the label of what was pressed, never what was
/// typed. A label that is only a digit or two (a PIN pad key) is recorded as
/// "number key". Detail maps have password, PIN, token and card keys replaced
/// with "[redacted]", and anything that looks like a card number is masked.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

class ActivityLog {
  ActivityLog._();

  /// The one logger for this app.
  static final ActivityLog instance = ActivityLog._();

  static const _fileRetainDays = 14;
  static const _flushEvery = Duration(seconds: 20);
  static const _maxQueued = 1000;
  static const _batch = 200;

  String app = 'app';
  String? appVersion;
  String? deviceId;
  String? deviceName;

  /// Where to send events, e.g. `https://backoffice.vesopaepos.com`. Null means
  /// local file only.
  String? apiBase;

  /// The bearer token to send with, read at send time so a sign-in or sign-out
  /// takes effect on the next batch. Null or empty holds events back.
  String? Function()? token;

  /// Who is using the app now: the member of staff on a till, the customer on
  /// the loyalty app. Set on sign-in, cleared on sign-out.
  String? actor;
  String? actorType;

  /// The screen currently showing, as the navigator observer last saw it.
  String? currentScreen;

  final String _session = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
  final List<Map<String, Object?>> _queue = [];
  Timer? _timer;
  bool _sending = false;
  IOSink? _sink;
  String? _sinkDay;
  Directory? _dir;
  bool _configured = false;

  /// Call once at start-up, before runApp.
  void configure({
    required String app,
    String? appVersion,
    String? apiBase,
    String? Function()? token,
    String? deviceId,
    String? deviceName,
    Directory? directory,
  }) {
    this.app = app;
    this.appVersion = appVersion;
    this.apiBase = apiBase;
    this.token = token;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    _dir = directory ?? _defaultDirectory(app);
    _configured = true;
    _timer ??= Timer.periodic(_flushEvery, (_) => flush());
    _pruneFiles();
    record('start', target: '$app ${appVersion ?? ''}'.trim());
  }

  /// Log uncaught Flutter and Dart errors as well as showing them as before.
  void installErrorHandlers() {
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      record('error', target: _firstLine(details.exceptionAsString()), detail: {
        'library': details.library,
        'context': details.context?.toDescription(),
        'stack': _stackHead(details.stack),
      });
      if (previous != null) {
        previous(details);
      } else {
        FlutterError.presentError(details);
      }
    };
    final platformPrevious = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stack) {
      record('error', target: _firstLine(error.toString()), detail: {'stack': _stackHead(stack)});
      return platformPrevious?.call(error, stack) ?? false;
    };
  }

  /// Write one event. Never throws.
  void record(String action, {String? target, Object? detail, String? actor, String? actorType}) {
    try {
      final event = <String, Object?>{
        'at': DateTime.now().toUtc().toIso8601String(),
        'action': action,
        if (target != null) 'target': scrub(target, 200),
        if (detail != null) 'detail': redact(detail),
        'actor': actor ?? this.actor,
        'actor_type': actorType ?? this.actorType,
        'screen': currentScreen,
        'session_id': _session,
      };
      _writeLocal(event);
      if (apiBase != null && apiBase!.isNotEmpty) {
        _queue.add(event);
        if (_queue.length > _maxQueued) _queue.removeRange(0, _queue.length - _maxQueued);
        if (_queue.length >= 50) unawaited(flush());
      }
    } catch (_) {
      // See the note at the top of the file.
    }
  }

  /// A member of staff or customer signed in or out.
  void signedIn(String? who, {String type = 'staff'}) {
    actor = who;
    actorType = type;
    record('signin', target: who);
  }

  void signedOut() {
    record('signout', target: actor);
    actor = null;
  }

  /// Send what is queued. Returns quietly on any failure; the events stay
  /// queued (up to a thousand) for the next attempt.
  Future<void> flush() async {
    if (_sending || _queue.isEmpty) return;
    final base = apiBase;
    final bearer = token?.call();
    if (base == null || base.isEmpty || bearer == null || bearer.isEmpty) return;
    _sending = true;
    try {
      while (_queue.isNotEmpty) {
        final batch = _queue.take(_batch).toList();
        final res = await http
            .post(
              Uri.parse('$base/activity/v1/events'),
              headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $bearer'},
              body: jsonEncode({
                'app': app,
                'app_version': appVersion,
                'device_id': deviceId,
                'device_name': deviceName,
                'events': [
                  for (final e in batch)
                    {...e, 'detail': _withScreen(e['detail'], e['screen'])}..remove('screen'),
                ],
              }),
            )
            .timeout(const Duration(seconds: 15));
        if (res.statusCode == 200) {
          _queue.removeRange(0, batch.length);
        } else if (res.statusCode == 401 || res.statusCode == 404 || res.statusCode == 400) {
          // Signed out, or a server without the route yet: these will not
          // succeed by retrying. Drop them; the local file still has them.
          _queue.removeRange(0, batch.length);
          break;
        } else {
          break;
        }
      }
    } catch (_) {
      // Offline. Try again next time.
    } finally {
      _sending = false;
    }
  }

  Object? _withScreen(Object? detail, Object? screen) {
    if (screen == null) return detail;
    if (detail == null) return {'screen': screen};
    if (detail is Map) return {'screen': screen, ...detail};
    return {'screen': screen, 'value': detail};
  }

  // ---------------------------------------------------------------------------
  // Taps and screens
  // ---------------------------------------------------------------------------

  /// Wrap the app (inside MaterialApp's builder, or around it) to record the
  /// label of everything tapped.
  Widget wrap(Widget child) => _TapRecorder(log: this, child: child);

  /// Add to MaterialApp.navigatorObservers to record screens opened.
  late final NavigatorObserver observer = _ScreenObserver(this);

  void _recordTap(Offset position, int viewId) {
    try {
      final result = HitTestResult();
      WidgetsBinding.instance.hitTestInView(result, position, viewId);
      final view = WidgetsBinding.instance.platformDispatcher.view(id: viewId);
      final screenArea = view == null
          ? double.infinity
          : (view.physicalSize.width * view.physicalSize.height) / (view.devicePixelRatio * view.devicePixelRatio);
      String? label;
      var textField = false;
      for (final entry in result.path) {
        final target = entry.target;
        if (target is! RenderObject) continue;
        if (target is RenderEditable) {
          textField = true;
          break;
        }
        label = _textUnder(target, _Budget(80));
        if (label != null && label.isNotEmpty) break;
        if (target is RenderBox && target.hasSize && target.size.width * target.size.height > screenArea / 4) {
          break;
        }
      }
      if (textField) {
        record('tap', target: 'text field');
        return;
      }
      label = (label ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();
      if (label.isEmpty) {
        record('tap', target: '(no label)', detail: {'x': position.dx.round(), 'y': position.dy.round()});
        return;
      }
      // A PIN pad key, a quantity digit or a masked character: never the value.
      if (RegExp(r'^[\d•*●]{1,2}$').hasMatch(label)) label = 'number key';
      record('tap', target: label.length > 80 ? '${label.substring(0, 80)}…' : label);
    } catch (_) {
      // A tap that could not be described is not worth an error.
    }
  }

  String? _textUnder(RenderObject node, _Budget budget) {
    if (budget.left-- <= 0) return null;
    if (node is RenderParagraph) return node.text.toPlainText();
    if (node is RenderEditable) return null;
    String? found;
    node.visitChildren((child) {
      if (found != null) return;
      final t = _textUnder(child, budget);
      if (t != null && t.trim().isNotEmpty) found = t;
    });
    return found;
  }

  // ---------------------------------------------------------------------------
  // The local file
  // ---------------------------------------------------------------------------

  static Directory? _defaultDirectory(String app) {
    try {
      if (kIsWeb) return null;
      final env = Platform.environment;
      if (Platform.isWindows) {
        final base = env['LOCALAPPDATA'] ?? env['APPDATA'];
        if (base != null) return Directory('$base${Platform.pathSeparator}Vesopa${Platform.pathSeparator}$app${Platform.pathSeparator}logs');
      }
      if ((Platform.isMacOS || Platform.isIOS) && env['HOME'] != null) {
        return Directory('${env['HOME']}/Library/Caches/vesopa-$app-logs');
      }
      if (Platform.isLinux && env['HOME'] != null) {
        return Directory('${env['HOME']}/.local/share/vesopa/$app/logs');
      }
      return Directory('${Directory.systemTemp.path}${Platform.pathSeparator}vesopa-$app-logs');
    } catch (_) {
      return null;
    }
  }

  /// Where the local files are, for a settings screen or a support call.
  String? get directoryPath => _dir?.path;

  void _writeLocal(Map<String, Object?> event) {
    final dir = _dir;
    if (!_configured || dir == null) return;
    try {
      final day = (event['at'] as String).substring(0, 10);
      if (_sink == null || _sinkDay != day) {
        _sink?.close();
        dir.createSync(recursive: true);
        _sink = File('${dir.path}${Platform.pathSeparator}activity-$day.jsonl').openWrite(mode: FileMode.append);
        _sinkDay = day;
      }
      _sink!.writeln(jsonEncode({'app': app, 'app_version': appVersion, ...event}));
    } catch (_) {
      _sink = null;
    }
  }

  void _pruneFiles() {
    final dir = _dir;
    if (dir == null) return;
    Future(() {
      if (!dir.existsSync()) return;
      final cutoff = DateTime.now().subtract(const Duration(days: _fileRetainDays)).toIso8601String().substring(0, 10);
      for (final f in dir.listSync().whereType<File>()) {
        final m = RegExp(r'activity-(\d{4}-\d{2}-\d{2})\.jsonl$').firstMatch(f.path);
        if (m != null && m.group(1)!.compareTo(cutoff) < 0) f.deleteSync();
      }
    }).catchError((_) {});
  }

  // ---------------------------------------------------------------------------
  // Redaction: the same rules as the server's activity_log.js.
  // ---------------------------------------------------------------------------

  static final RegExp _secretKey = RegExp(
    [
      r'pass(word|wd|code|phrase)?', 'pin', r'pin_?hash', 'secret', 'token',
      r'authori[sz]ation', 'cookie', r'session_?id', r'api_?key', r'private_?key',
      'signature', r'card_?(number|no|num)', 'pan', r'cvv2?', r'cvc2?', 'cv2',
      r'security_?code', 'expiry', r'exp_?(month|year|date)', 'iban', 'bic',
      r'account_?number', r'sort_?code', 'otp', r'one_?time_?code',
      r'verification_?code', r'auth_?code', r'reset_?code', r'code_?verifier',
      r'client_?secret', 'refresh', r'id_?token', r'access_?token', 'jwt',
      'credential', 'hash', 'salt', 'totp', 'recovery', 'mfa',
      // OAuth authorisation codes, voucher and gift codes: all spendable.
      'code',
    ].map((k) => '(^|_)$k(\$|_)').join('|'),
    caseSensitive: false,
  );

  static String _snake(String key) => key
      .replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (m) => '${m[1]}_${m[2]}')
      .replaceAll(RegExp(r'[-\s]+'), '_')
      .toLowerCase();

  static bool _luhn(String digits) {
    var sum = 0;
    var dbl = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var d = digits.codeUnitAt(i) - 48;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 == 0;
  }

  /// Mask card numbers and tokens in free text, and bound its length.
  static String scrub(String text, [int max = 300]) {
    var s = text.replaceAll(
      RegExp(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b'),
      '[redacted-token]',
    );
    s = s.replaceAllMapped(RegExp(r'\b\d(?:[ -]?\d){12,18}\b'), (m) {
      final digits = m[0]!.replaceAll(RegExp(r'[ -]'), '');
      return _luhn(digits) ? '[card ••••${digits.substring(digits.length - 4)}]' : m[0]!;
    });
    return s.length > max ? '${s.substring(0, max)}…' : s;
  }

  /// A copy of [value] that is safe to write down.
  static Object? redact(Object? value, [int depth = 0]) {
    if (value == null || value is num || value is bool) return value;
    if (value is String) return scrub(value);
    if (value is DateTime) return value.toIso8601String();
    if (depth >= 4) return value is List ? '[${value.length} items]' : '[…]';
    if (value is List) {
      final out = value.take(20).map((v) => redact(v, depth + 1)).toList();
      if (value.length > 20) out.add('…${value.length - 20} more');
      return out;
    }
    if (value is Map) {
      final out = <String, Object?>{};
      for (final entry in value.entries.take(40)) {
        final key = entry.key.toString();
        out[key] = _secretKey.hasMatch(_snake(key)) ? '[redacted]' : redact(entry.value, depth + 1);
      }
      return out;
    }
    return scrub(value.toString(), 100);
  }

  static String _firstLine(String s) => scrub(s.split('\n').first, 200);

  static String? _stackHead(StackTrace? stack) {
    if (stack == null) return null;
    return stack.toString().split('\n').take(8).join('\n');
  }
}

class _Budget {
  _Budget(this.left);
  int left;
}

class _TapRecorder extends StatefulWidget {
  const _TapRecorder({required this.log, required this.child});
  final ActivityLog log;
  final Widget child;

  @override
  State<_TapRecorder> createState() => _TapRecorderState();
}

class _TapRecorderState extends State<_TapRecorder> with WidgetsBindingObserver {
  final Map<int, (Offset, DateTime)> _down = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.log.record('resume');
    if (state == AppLifecycleState.paused || state == AppLifecycleState.detached) {
      widget.log.record(state.name);
      unawaited(widget.log.flush());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (e) => _down[e.pointer] = (e.position, DateTime.now()),
      onPointerCancel: (e) => _down.remove(e.pointer),
      onPointerUp: (PointerUpEvent e) {
        final start = _down.remove(e.pointer);
        if (start == null) return;
        // A tap, not a scroll or a drag.
        if ((e.position - start.$1).distance > 24) return;
        if (DateTime.now().difference(start.$2) > const Duration(seconds: 2)) return;
        widget.log._recordTap(e.position, View.of(context).viewId);
      },
      child: widget.child,
    );
  }
}

class _ScreenObserver extends NavigatorObserver {
  _ScreenObserver(this.log);
  final ActivityLog log;

  String _name(Route<dynamic>? route) {
    if (route == null) return 'unknown';
    final name = route.settings.name;
    if (name != null && name.isNotEmpty) return name;
    if (route is PopupRoute) return 'dialog';
    return route.runtimeType.toString().replaceAll(RegExp(r'<.*>'), '');
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    log.currentScreen = _name(route);
    log.record('screen', target: log.currentScreen, detail: {'from': _name(previousRoute)});
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    log.currentScreen = _name(previousRoute);
    log.record('screen', target: log.currentScreen, detail: {'closed': _name(route)});
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    log.currentScreen = _name(newRoute);
    log.record('screen', target: log.currentScreen, detail: {'replaced': _name(oldRoute)});
  }
}
