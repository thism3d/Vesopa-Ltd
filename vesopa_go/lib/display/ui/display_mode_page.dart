/// Vesopa Go as a customer display (owner, 2026-11-03).
///
/// It follows one till: the Windows customer display's link (data/
/// till_link.dart, copied by tool/sync_go_modes.py), over the venue's own
/// network first and the back office when the two are on different networks
/// ("both, local first"). Until a till connects it, it shows a four-digit
/// code for the till to choose.
///
/// What the customer sees, in the till's own order of importance:
///   a card payment     the amount and the card machine's words; the QR to
///                      pay from their own phone when the till offers it
///   the bill           every line as it is rung up, the totals, a greeting
///   paid               the venue's thank-you and the change
///   nothing going on   the venue's adverts (pictures and films, from the
///                      back office), with the venue's name, the time and
///                      its standing message and QR
///
/// Large type, generous spacing and one thing at a time, as Apple asks of a
/// screen read from a distance. Motion eases on Apple's curve and stops with
/// Reduce Motion. The screen stays awake; settings need a manager's PIN.
library;

import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import '../../nfc/card_read_sheet.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:qr_flutter/qr_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'dart:convert';
import 'dart:io';

import '../../config/constants.dart';
import '../../data/api.dart';
import '../../data/models.dart' show money;
import '../../data/session.dart';
import '../../modes/mode_settings.dart';
import '../../data/lan/lan_service.dart';
import '../../ui/pages/connection_page.dart';
import '../../ui/pages/scan_sheet.dart';
import '../../ui/sounds.dart';
import '../../ui/theme.dart';
import '../../ui/tv.dart';
import '../data/basket_feed.dart';
import '../data/control.dart';
import '../data/display_options.dart';
import '../data/local_adverts.dart';
import '../data/till_link.dart';

const _ease = Cubic(0.2, 0, 0, 1);

class DisplayModePage extends ConsumerStatefulWidget {
  const DisplayModePage({super.key});
  @override
  ConsumerState<DisplayModePage> createState() => _DisplayModePageState();
}

class _DisplayModePageState extends ConsumerState<DisplayModePage> {
  static const _codeKey = 'go_display_code';
  static const _tokenKey = 'go_display_token';
  TillLink? _link;
  String? _token;
  String _code = '';
  String? _problem;
  String? _paidTo;
  Basket _basket = Basket.unknown;
  TillControl? _control;
  DisplayOptions _options = const DisplayOptions();
  String? _lastResult;
  DateTime _lastChange = DateTime.now();
  List<_Advert> _adverts = const [];

  /// Pictures and films kept on this device (data/local_adverts.dart).
  List<LocalAdvert> _local = const [];
  bool _localOnly = false;

  /// What plays: the venue's, then this device's own; or only its own.
  List<_Advert> get _playing => [
        if (!_localOnly || _local.isEmpty) ..._adverts,
        for (final a in _local) _Advert(url: a.path, video: a.video, seconds: a.seconds, file: true),
      ];

  Future<void> _loadLocal() async {
    final list = await LocalAdverts.load();
    final only = await LocalAdverts.only();
    if (mounted) {
      setState(() {
        _local = list;
        _localOnly = only;
      });
    }
  }
  Timer? _tick;
  Timer? _status;

  // The remote (owner, 2026-11-18): a TV has no touch, so the arrows turn the
  // adverts and OK opens the settings, behind the manager's PIN as before.
  final _keys = FocusNode(debugLabel: 'display-remote');
  final _slides = GlobalKey<_SlidesState>();
  bool _hint = false;
  Timer? _hintTimer;
  bool _inSettings = false;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable().catchError((Object _) {});
    DisplayOptions.load().then((o) {
      if (!mounted) return;
      setState(() => _options = o);
      _applyScreen();
    });
    // The display, not the till, is on the venue's link now.
    TapSession.lanHeldByDisplay = true;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _start();
      // On a TV, say once what the remote does.
      if (GoDevice.remote.value && mounted) _showHint();
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _status?.cancel();
    _hintTimer?.cancel();
    _keys.dispose();
    // The rest of the app has its own bars and turns as it likes.
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
    unawaited(SystemChrome.setPreferredOrientations(const []));
    _link?.stop();
    TapSession.lanHeldByDisplay = false;
    WakelockPlus.disable().catchError((Object _) {});
    super.dispose();
  }

  Future<void> _start() async {
    setState(() => _problem = null);
    final prefs = await SharedPreferences.getInstance();
    _code = prefs.getString(_codeKey) ?? '';
    if (_code.length != 4) {
      _code = (1000 + Random.secure().nextInt(9000)).toString();
      await prefs.setString(_codeKey, _code);
    }
    _token = prefs.getString(_tokenKey);
    final raw = prefs.getString('display.remote_pairing');
    if (raw != null) {
      try {
        _paidTo = (jsonDecode(raw) as Map)['terminalName'] as String?;
      } catch (_) {}
    }
    if (_token == null) {
      try {
        final r = await ref.read(apiProvider).goModeToken('display', deviceName: ref.read(tapProvider.notifier).terminalName);
        _token = '${r['token']}';
        await prefs.setString(_tokenKey, _token!);
      } on TapApiError catch (e) {
        if (mounted) setState(() => _problem = e.message);
        return;
      }
    }
    final session = ref.read(tapProvider.notifier);
    final link = TillLink(
      deviceId: 'go-${session.deviceId}',
      deviceName: '${session.terminalName} display',
      appVersion: 'go',
      cloudBase: apiBase,
    )
      ..onBasket = _onBasket
      ..onControl = _onControl
      ..onPaired = (terminal, name) async {
        final p = await SharedPreferences.getInstance();
        await p.setString('display.remote_pairing', jsonEncode({'terminal': terminal, 'terminalName': name}));
        if (mounted) setState(() => _paidTo = name);
      }
      ..onUnpaired = () async {
        final p = await SharedPreferences.getInstance();
        await p.remove('display.remote_pairing');
        if (mounted) {
          setState(() {
            _paidTo = null;
            _basket = Basket.unknown;
          });
        }
      }
      ..onChange = () {
        if (mounted) setState(() {});
      };
    _link = link;
    link.configure(basketPath: '', token: _token, code: _code);
    link.start();
    _status = Timer.periodic(const Duration(seconds: 15), (_) => _sendStatus());
    unawaited(_loadAdverts());
    unawaited(_loadLocal());
  }

  /// A customer's member card or pass, passed to the till this screen follows.
  /// The till treats it as a card swiped there, so points work as they always do.
  void _passToTill(String code) {
    if (!mounted || code.trim().isEmpty) return;
    _sendStatus(memberScan: code.trim());
    final words = _paidTo == null ? 'This screen is not connected to a till yet.' : 'Thank you. Sent to the till.';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(words)));
  }

  Future<void> _tapMemberCard() async {
    final code = await readCard(
      context,
      title: 'Tap your card',
      hint: 'Hold your member, loyalty or gift card against the back of this screen',
      cameraHint: 'Show the code on your card or pass to the camera',
    );
    if (code != null) _passToTill(code);
  }

  Future<void> _scanPass() async {
    final code = await scanCode(context, title: 'Scan your member pass');
    if (code != null) _passToTill(code);
  }

  void _sendStatus({String? memberScan}) {
    final size = MediaQuery.maybeSizeOf(context);
    final report = DisplayStatusReport(
      appVersion: 'Vesopa Go',
      following: _paidTo ?? '',
      advertCount: _playing.length,
      width: size?.width.round() ?? 0,
      height: size?.height.round() ?? 0,
      link: _link?.route ?? 'cloud',
      childLock: _locked,
    ).toJson();
    _link?.sendStatus({
      ...report,
      if (memberScan != null) 'member_scan': {'code': memberScan, 'at': DateTime.now().millisecondsSinceEpoch},
    });
  }

  /// Off on this screen, or locked from the till. The till's lock wins: a lock
  /// the locked screen could undo would not be one.
  bool get _locked => !_options.touch || (_control?.childLock ?? false) || !(_control?.touch ?? true);

  void _onBasket(Object? raw) {
    if (raw is! Map) return;
    final b = Basket.fromJson(raw.cast<String, Object?>());
    if (b == null || !mounted) return;
    setState(() {
      if (b.state != _basket.state || b.lines.length != _basket.lines.length || b.totalMinor != _basket.totalMinor) {
        _lastChange = DateTime.now();
      }
      _basket = b;
    });
  }

  void _onControl(Object? raw) {
    final c = TillControl.fromJson(raw);
    if (c != null && mounted) setState(() => _control = c);
  }

  /// The venue's adverts from the back office (display_adverts.js), every
  /// ten minutes, so a new upload plays without anybody touching the screen.
  Future<void> _loadAdverts() async {
    while (mounted) {
      try {
        final r = await http
            .get(Uri.parse('$apiBase/api/display/adverts'), headers: {'Authorization': 'Bearer $_token'})
            .timeout(const Duration(seconds: 12));
        if (r.statusCode == 401) {
          // The display credential went: ask the device's own sign-in again.
          final prefs = await SharedPreferences.getInstance();
          await prefs.remove(_tokenKey);
          _link?.stop();
          if (mounted) _start();
          return;
        }
        if (r.statusCode == 200) {
          final list = (jsonDecode(r.body) as Map)['adverts'] as List? ?? const [];
          final next = [
            for (final a in list)
              if (a is Map)
                _Advert(
                  url: '${a['url']}'.startsWith('http') ? '${a['url']}' : '$apiBase${a['url']}',
                  video: a['kind'] == 'video',
                  seconds: (a['seconds'] as num?)?.toInt() ?? 10,
                ),
          ];
          if (mounted) setState(() => _adverts = next);
        }
      } catch (_) {
        // Offline: what is already showing carries on.
      }
      await Future<void>.delayed(const Duration(minutes: 10));
    }
  }

  /// The till's settings with this screen's own on top (display_options.dart).
  TillControl get _ctl => _options.applyTo(_control);

  /// How the adverts play here.
  _Look get _look {
    final c = _ctl;
    return _Look(dwell: c.dwellSeconds, volume: c.advertVolume, fillStills: _options.fillStills, fillVideos: _options.fillVideos);
  }

  bool get _idle {
    final c = _ctl;
    if (_basket.card != null) return false;
    final since = DateTime.now().difference(_lastChange);
    if (_basket.state == 'paid') {
      // Zero holds the thank-you until the next sale, as on Windows.
      return c.thankYouSeconds > 0 && since > Duration(seconds: c.thankYouSeconds);
    }
    // A bill nobody has added to for the idle time gives the screen back to
    // the adverts (the Windows display's "when the till goes quiet"); zero
    // keeps the bill up for as long as it is open.
    if (_basket.hasSale) return c.idleSeconds > 0 && since > Duration(seconds: c.idleSeconds);
    return since > Duration(seconds: c.idleSeconds <= 0 ? 10 : min(c.idleSeconds, 10));
  }

  void _showHint() {
    _hintTimer?.cancel();
    if (!_hint) setState(() => _hint = true);
    _hintTimer = Timer(const Duration(seconds: 6), () {
      if (mounted) setState(() => _hint = false);
    });
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
    // A button on the screen has the focus (the member card, Try again):
    // the arrows move between them as everywhere else.
    if (!_keys.hasPrimaryFocus) return KeyEventResult.ignored;
    final k = event.logicalKey;
    _showHint();
    if (k == LogicalKeyboardKey.arrowLeft) {
      _slides.currentState?.previous();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowRight) {
      _slides.currentState?.next();
      return KeyEventResult.handled;
    }
    final open = <LogicalKeyboardKey>{
      LogicalKeyboardKey.select,
      LogicalKeyboardKey.enter,
      LogicalKeyboardKey.numpadEnter,
      LogicalKeyboardKey.gameButtonA,
      LogicalKeyboardKey.contextMenu,
      LogicalKeyboardKey.f1,
    };
    if (open.contains(k)) {
      if (event is KeyDownEvent) _settings();
      return KeyEventResult.handled;
    }
    // Up and down go on to the app's remote, which moves to a button below.
    return KeyEventResult.ignored;
  }

  Future<void> _settings() async {
    if (_inSettings) return;
    _inSettings = true;
    try {
      await _openSettings();
    } finally {
      _inSettings = false;
      if (mounted && FocusManager.instance.primaryFocus is FocusScopeNode) _keys.requestFocus();
    }
  }

  Future<void> _openSettings() async {
    await showModeSettings(context, ref, extra: [
      Card(
        child: ListTile(
          leading: const Icon(Icons.link_rounded),
          title: Text(_paidTo == null ? 'Not connected to a till' : 'Following $_paidTo'),
          subtitle: Text('Code $_code · ${switch (_link?.route) { 'lan' => 'over the venue\'s network', 'cloud' => 'through the back office', _ => 'waiting' }}'),
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.tune_rounded),
          title: const Text('Display options'),
          subtitle: const Text('Touch, sound and the pay screen. Saved to the back office.'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () {
            Navigator.pop(context);
            _displayOptions();
          },
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.router_rounded),
          title: const Text('Network and hardware'),
          subtitle: const Text('How this display hears its till: the Wi-Fi, the back office'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () {
            Navigator.pop(context);
            Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => ConnectionPage(mode: ConnectionMode.display, sections: (_) => _connections()),
            ));
          },
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.refresh_rounded),
          title: const Text('New code'),
          subtitle: const Text('For connecting this display to a different till.'),
          onTap: () async {
            Navigator.pop(context);
            final p = await SharedPreferences.getInstance();
            await p.remove(_codeKey);
            await p.remove('display.remote_pairing');
            _link?.stop();
            _status?.cancel();
            if (mounted) {
              setState(() => _paidTo = null);
              _start();
            }
          },
        ),
      ),
    ]);
  }

  Future<void> _setOptions(DisplayOptions o) async {
    final before = _options;
    setState(() => _options = o);
    if (before.fullScreen != o.fullScreen || before.orientation != o.orientation) _applyScreen();
    await o.save();
  }

  /// Full screen and a fixed way up, as this display is set.
  void _applyScreen() {
    unawaited(SystemChrome.setEnabledSystemUIMode(_options.fullScreen ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge));
    unawaited(SystemChrome.setPreferredOrientations(switch (_options.orientation) {
      'landscape' => const [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
      'portrait' => const [DeviceOrientation.portraitUp, DeviceOrientation.portraitDown],
      _ => const <DeviceOrientation>[],
    }));
  }

  /// One answer from a short list, in a dialog a remote can work.
  Future<T?> _pick<T>(String title, T current, List<(T, String)> choices) => showDialog<T>(
        context: context,
        builder: (c) => SimpleDialog(
          title: Text(title),
          children: [
            for (final (value, label) in choices)
              ListTile(
                autofocus: value == current,
                leading: Icon(value == current ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded,
                    color: value == current ? Tp.lime : null),
                title: Text(label),
                onTap: () => Navigator.pop(c, value),
              ),
          ],
        ),
      );

  /// A line of words. Empty gives the till's back.
  Future<String?> _type(String title, String current, {String? hint, int lines = 1}) {
    final words = TextEditingController(text: current);
    return showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: words,
          autofocus: true,
          maxLines: lines,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(hintText: hint ?? 'Empty: what the till says'),
          onSubmitted: lines == 1 ? (v) => Navigator.pop(c, v) : null,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, words.text), child: const Text('Save')),
        ],
      ),
    );
  }

  /// What a manager can change here, after their PIN: everything the Windows
  /// customer display can be set to, in its sections and its words.
  Future<void> _displayOptions() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (c) => StatefulBuilder(builder: (c, redraw) {
      void set(DisplayOptions o) {
        _setOptions(o);
        redraw(() {});
      }
      final o = _options;
      final till = _control;
      final t = Theme.of(c).textTheme;
      String secs(int s) => s >= 120 && s % 60 == 0 ? '${s ~/ 60} minutes' : '$s seconds';
      String follow(String what) => 'What the till says${what.isEmpty ? '' : ' ($what)'}';

      Widget section(String title, IconData icon, List<Widget> rows) => Padding(
            padding: const EdgeInsets.only(top: 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                child: Row(children: [
                  Icon(icon, size: 18, color: Tp.lime),
                  const SizedBox(width: 8),
                  Text(title.toUpperCase(), style: t.labelLarge?.copyWith(letterSpacing: 1.2, fontWeight: FontWeight.w800)),
                ]),
              ),
              Card(margin: EdgeInsets.zero, clipBehavior: Clip.antiAlias, child: Column(children: rows)),
            ]),
          );
      Widget flag(String title, String detail, bool value, DisplayOptions Function(bool) change) => SwitchListTile(
            title: Text(title),
            subtitle: Text(detail),
            value: value,
            onChanged: (v) => set(change(v)),
          );
      Widget choice(String title, String value, VoidCallback onTap) => ListTile(
            title: Text(title),
            subtitle: Text(value, style: TextStyle(color: Tp.lime.withValues(alpha: 0.9))),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: onTap,
          );
      Widget words(String title, String mine, String theirs, Future<void> Function(String) save, {String? hint, int lines = 1}) => choice(
            title,
            mine.isNotEmpty ? mine : (theirs.isEmpty ? 'Nothing' : follow(theirs)),
            () async {
              final v = await _type(title, mine, hint: hint, lines: lines);
              if (v != null) await save(v.trim());
            },
          );

      final tileIds = o.followsTillTiles ? (till?.tiles ?? const <String>[]) : o.tileList;
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 28),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Display options', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          Text('Saved on this screen and in the back office. "What the till says" follows the till this display is paired with.',
              style: t.bodyMedium?.copyWith(color: Colors.white60)),
          section('Big screen', Icons.tv_rounded, [
            flag('Full screen', "Hide the device's own bars, so the screen is all display.", o.fullScreen, (v) => o.copyWith(fullScreen: v)),
            choice('Which way up', switch (o.orientation) { 'landscape' => 'Landscape', 'portrait' => 'Portrait', _ => 'As the device is turned' }, () async {
              final v = await _pick('Which way up', o.orientation, const [('auto', 'As the device is turned'), ('landscape', 'Landscape'), ('portrait', 'Portrait')]);
              if (v != null) set(o.copyWith(orientation: v));
            }),
            ListTile(
              title: const Text('Size of the words'),
              subtitle: Text('${(o.textScale * 100).round()} per cent${(till?.zoom ?? 100) != 100 ? ', and the till zooms ${till!.zoom}%' : ''}'),
            ),
            Slider(value: o.textScale, min: 0.8, max: 1.6, divisions: 8, label: '${(o.textScale * 100).round()}%', onChanged: (v) => set(o.copyWith(textScale: v))),
            flag('Touch', 'Off: customers cannot touch anything on this screen. The remote and the corner still work.', o.touch, (v) => o.copyWith(touch: v)),
          ]),
          section('Adverts', Icons.slideshow_rounded, [
            ListTile(
              leading: const Icon(Icons.perm_media_rounded),
              title: const Text('Adverts on this device'),
              subtitle: const Text("Play pictures and films from this device's files and photos."),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () async {
                await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LocalAdvertsPage()));
                unawaited(_loadLocal());
              },
            ),
            choice('Each picture stays up for', o.dwellSeconds == 0 ? "Each advert's own time" : secs(o.dwellSeconds), () async {
              final v = await _pick('Each picture stays up for', o.dwellSeconds, [
                (0, "Each advert's own time"),
                for (final n in const [5, 8, 10, 12, 15, 20, 30, 60]) (n, secs(n)),
              ]);
              if (v != null) set(o.copyWith(dwellSeconds: v));
            }),
            choice('Film sound', o.advertVolume < 0 ? follow(till == null ? '' : (till.advertVolume == 0 ? 'silent' : '${till.advertVolume}%')) : (o.advertVolume == 0 ? 'Silent' : '${o.advertVolume} per cent'), () async {
              final v = await _pick('Film sound', o.advertVolume, const [(-1, 'What the till says'), (0, 'Silent'), (25, '25 per cent'), (50, '50 per cent'), (75, '75 per cent'), (100, 'Full')]);
              if (v != null) set(o.copyWith(advertVolume: v));
            }),
            flag('Pictures fill the screen', 'Cropped to fit. Off shows the whole picture, with bars.', o.fillStills, (v) => o.copyWith(fillStills: v)),
            flag('Films fill the screen', 'The same for films, which are often cut to another shape.', o.fillVideos, (v) => o.copyWith(fillVideos: v)),
            ListTile(title: const Text('Dim adverts while waiting'), subtitle: Text(o.idleDim == 0 ? 'Off' : '${o.idleDim} per cent darker')),
            Slider(value: o.idleDim.toDouble(), max: 80, divisions: 8, label: '${o.idleDim}%', onChanged: (v) => set(o.copyWith(idleDim: v.round()))),
          ]),
          section('While a bill is on screen', Icons.receipt_long_rounded, [
            flag('Prices on each line', 'Off hides line prices, whatever the till says. The total always shows.', o.showPrices, (v) => o.copyWith(showPrices: v)),
            flag('Discounts', 'Discounts and savings on the bill.', o.showDiscount, (v) => o.copyWith(showDiscount: v)),
            flag('Adverts beside the bill', 'On a wide screen. Off gives the bill the whole screen.', o.saleAdverts, (v) => o.copyWith(saleAdverts: v)),
            choice('Bill on the', switch (o.billSide) { 'left' => 'Left', 'right' => 'Right', _ => follow(till == null ? '' : (till.billOnRight ? 'right' : 'left')) }, () async {
              final v = await _pick('Bill on the', o.billSide, const [('till', 'What the till says'), ('left', 'Left'), ('right', 'Right')]);
              if (v != null) set(o.copyWith(billSide: v));
            }),
            choice('Bill takes', o.billShare == 0 ? follow(till == null ? '' : '${till.billShare}%') : '${o.billShare} per cent of the screen', () async {
              final v = await _pick('Bill takes', o.billShare, const [(0, 'What the till says'), (30, '30 per cent'), (40, '40 per cent'), (50, 'Half'), (60, '60 per cent'), (70, '70 per cent')]);
              if (v != null) set(o.copyWith(billShare: v));
            }),
          ]),
          section('Tiles', Icons.dashboard_customize_rounded, [
            SwitchListTile(
              title: const Text("The till's tiles"),
              subtitle: const Text('Off: choose this screen\'s own below.'),
              value: o.followsTillTiles,
              onChanged: (v) => set(o.copyWith(tiles: v ? 'till' : (till?.tiles ?? const []).join(','))),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Wrap(spacing: 8, runSpacing: 8, children: [
                for (final e in displayTiles.entries)
                  FilterChip(
                    label: Text(e.value),
                    selected: tileIds.contains(e.key),
                    onSelected: o.followsTillTiles
                        ? null
                        : (on) {
                            final next = [...o.tileList]..remove(e.key);
                            if (on) next.add(e.key);
                            set(o.copyWith(tiles: next.join(',')));
                          },
                  ),
              ]),
            ),
            if (!o.followsTillTiles) ...[
              choice('Tiles sit', o.tilePlace == 'side' ? 'Down the side' : 'Along the bottom', () async {
                final v = await _pick('Tiles sit', o.tilePlace, const [('bottom', 'Along the bottom'), ('side', 'Down the side')]);
                if (v != null) set(o.copyWith(tilePlace: v));
              }),
            ],
            words('Welcome tile', o.welcomeText, till?.welcomeText ?? '', (v) async => set(o.copyWith(welcomeText: v)), hint: 'Welcome to the club'),
            words("Special's heading", o.specialTitle, till?.specialTitle ?? '', (v) async => set(o.copyWith(specialTitle: v)), hint: "Today's special"),
            words("Special's words", o.specialText, till?.specialText ?? '', (v) async => set(o.copyWith(specialText: v)), hint: 'Sunday roast, £14.95', lines: 3),
          ]),
          section('When the till goes quiet', Icons.bedtime_rounded, [
            choice('Adverts take over after', o.idleSeconds < 0
                ? follow(till == null ? '' : (till.idleSeconds == 0 ? 'never' : secs(till.idleSeconds)))
                : (o.idleSeconds == 0 ? 'Never: a bill stays up while it is open' : '${secs(o.idleSeconds)} with no change to the bill'), () async {
              final v = await _pick('Adverts take over after', o.idleSeconds, [
                (-1, 'What the till says'),
                (0, 'Never'),
                for (final n in const [20, 30, 45, 60, 90, 120, 300]) (n, secs(n)),
              ]);
              if (v != null) set(o.copyWith(idleSeconds: v));
            }),
          ]),
          section('What the customer reads', Icons.chat_bubble_outline_rounded, [
            words('Thank-you', o.thankYou, till?.thankYou ?? 'Thank you', (v) async => set(o.copyWith(thankYou: v)), hint: 'Thank you, see you soon'),
            choice('Thank-you stays up for', o.thanksSeconds == 0 ? follow(till == null ? '' : (till.thankYouSeconds == 0 ? 'until the next sale' : secs(till.thankYouSeconds))) : secs(o.thanksSeconds), () async {
              final v = await _pick('Thank-you stays up for', o.thanksSeconds, [
                (0, 'What the till says'),
                for (final n in const [5, 10, 20, 30, 60]) (n, secs(n)),
              ]);
              if (v != null) set(o.copyWith(thanksSeconds: v));
            }),
            words('Standing message', o.standingMessage, till?.standingMessage ?? '', (v) async => set(o.copyWith(standingMessage: v)), hint: 'Quiz night every Thursday'),
            words('QR code for customers', o.customerQr, till?.customerQr ?? '', (v) async => set(o.copyWith(customerQr: v)), hint: 'A web address, e.g. https://…'),
            if (o.customerQr.isNotEmpty)
              words('Line under the QR', o.customerQrCaption, '', (v) async => set(o.copyWith(customerQrCaption: v)), hint: 'Scan to join'),
            flag('Member buttons', 'Tap a member card or scan a pass on the waiting screen.', o.memberButtons, (v) => o.copyWith(memberButtons: v)),
          ]),
          section('Paying', Icons.contactless_rounded, [
            flag('Pay from a phone', 'Show the QR code when the till offers it.', o.showQr, (v) => o.copyWith(showQr: v)),
            flag('Amount to pay', 'The amount in big figures on the pay screen.', o.showAmount, (v) => o.copyWith(showAmount: v)),
            flag('Card steps', 'What the card is doing, as the till words it.', o.showCardSteps, (v) => o.copyWith(showCardSteps: v)),
            flag('Cards we take', 'Card and wallet names under the pay screen.', o.showCardMarks, (v) => o.copyWith(showCardMarks: v)),
            flag('Sound', 'A chime when a payment is approved or declined.', o.sound, (v) => o.copyWith(sound: v)),
          ]),
        ]),
      );
    }),
  );

  /// A chime once per payment result, when the display is set to make one.
  void _noticeResult() {
    final card = _basket.card;
    if (card == null || !card.isResult) {
      _lastResult = null;
      return;
    }
    final key = '${card.approved}|${card.amountMinor}|${card.title}';
    if (key == _lastResult) return;
    _lastResult = key;
    if (_options.sound) {
      final go = ref.read(tapProvider.select((s) => s.config.go));
      unawaited(GoSounds.play(go, card.approved ? GoSound.approved : GoSound.declined));
    }
  }

  /// The display's own rows on Network and hardware (2026-11-04): which till
  /// it follows and by which road, the venue's Wi-Fi first and the back
  /// office's relay when the Wi-Fi cannot.
  List<ConnSection> _connections() {
    final link = _link;
    final lan = LanService.instance;
    final size = MediaQuery.maybeSizeOf(context);
    final route = link?.route;
    return [
      ConnSection('Connection to the till', [
        ConnRow(Icons.point_of_sale_rounded, 'Following', _paidTo ?? 'No till yet: enter code $_code on a till', ok: _paidTo != null),
        ConnRow(Icons.alt_route_rounded, 'Road in use', switch (route) {
          'lan' => 'The venue Wi-Fi (local link): the bill shows as it is rung up',
          'cloud' => 'The back office relay, over the internet',
          'local' => 'This device',
          _ => 'Waiting for the till',
        }, ok: route == 'lan' || route == 'cloud' || route == 'local'),
        ConnRow(Icons.lan_rounded, 'Local link', lan.node == null
            ? 'Not started'
            : (link?.lanUp ?? false)
                ? 'Hearing the till over the Wi-Fi'
                : lan.linked
                    ? 'On the venue network; the till has not spoken on it yet'
                    : 'Looking for the main till on this network', ok: link?.lanUp ?? false),
        ConnRow(Icons.cloud_sync_rounded, 'Back office relay', (link?.cloudUp ?? false) ? 'Connected' : 'Reconnecting', ok: link?.cloudUp ?? false),
        ConnRow(Icons.pin_rounded, 'Pairing code', _code, neutral: true),
      ], warnings: [
        if (link != null && !link.cloudUp && !link.lanUp) 'This display can hear neither the till nor the back office. Check the Wi-Fi.',
      ]),
      ConnSection('This screen', [
        ConnRow(Icons.aspect_ratio_rounded, 'Size', size == null ? '' : '${size.width.round()} × ${size.height.round()} points', neutral: true),
        ConnRow(Icons.slideshow_rounded, 'Adverts', _playing.isEmpty ? 'None (back office > Devices > Customer display adverts, or Settings > Adverts on this device)' : '${_playing.length} playing when idle${_local.isEmpty ? '' : ', ${_local.length} from this device'}', neutral: true),
      ]),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final venue = ref.watch(tapProvider.select((s) => s.venue?.name)) ?? '';
    final reduce = MediaQuery.of(context).disableAnimations;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _noticeResult();
    });
    Widget screen;
    if (_problem != null) {
      screen = _Centre(
        icon: Icons.cloud_off_rounded,
        title: 'This display could not start',
        words: _problem!,
        action: FilledButton.icon(onPressed: _start, icon: const Icon(Icons.refresh_rounded), label: const Text('Try again')),
      );
    } else if (_paidTo == null && !(_link?.cloudUp == true && _basket.updatedAt.year > 2000)) {
      screen = _PairCode(code: _code, venue: venue, linked: _link?.cloudUp == true || _link?.lanUp == true);
    } else if (_basket.card != null) {
      screen = _CardScreen(card: _basket.card!, basket: _basket, options: _options);
    } else if (_idle) {
      screen = _Idle(
        slidesKey: _slides,
        adverts: _playing,
        look: _look,
        venue: venue,
        control: _ctl,
        dim: _options.idleDim,
        onMemberCard: _options.memberButtons ? _tapMemberCard : null,
        onScanPass: _options.memberButtons ? _scanPass : null,
      );
    } else if (_basket.state == 'paid') {
      screen = _ThankYou(basket: _basket, words: _ctl.thankYou);
    } else {
      screen = _Bill(
        basket: _basket,
        control: _ctl,
        adverts: _options.saleAdverts ? _playing : const [],
        look: _look,
        venue: venue,
        showDiscount: _options.showDiscount,
      );
    }
    // The tiles (clock, date, welcome, special, QR, cards, total) along the
    // bottom or down the side, over the adverts and the bill.
    final tiles = _ctl.tiles;
    if (tiles.isNotEmpty && (screen is _Idle || screen is _Bill)) {
      screen = _WithTiles(tiles: tiles, side: _ctl.tilePlace == 'side', control: _ctl, basket: _basket, venue: venue, child: screen);
    }
    return Scaffold(
      backgroundColor: const Color(0xFF0B0E0A),
      body: Focus(
        focusNode: _keys,
        autofocus: true,
        onKeyEvent: _onKey,
        child: Theme(
        data: Tp.theme(Brightness.dark),
        child: Stack(children: [
          Positioned.fill(
            child: AnimatedSwitcher(
              duration: reduce ? Duration.zero : const Duration(milliseconds: 600),
              switchInCurve: _ease,
              switchOutCurve: Curves.easeIn,
              transitionBuilder: (child, a) => FadeTransition(
                opacity: a,
                child: ScaleTransition(scale: Tween(begin: 0.98, end: 1.0).animate(a), child: child),
              ),
              child: KeyedSubtree(
                key: ValueKey(screen is _WithTiles ? screen.child.runtimeType : screen.runtimeType),
                // The corner below stays live, so staff are never locked out.
                child: AbsorbPointer(
                  absorbing: _locked,
                  child: MediaQuery(
                    data: MediaQuery.of(context).copyWith(
                      textScaler: TextScaler.linear((_options.textScale * _ctl.zoom / 100).clamp(0.6, 2.4)),
                    ),
                    child: screen,
                  ),
                ),
              ),
            ),
          ),
          // Staff only: a long press in the top corner, then a manager's PIN.
          Positioned(
            top: 0,
            right: 0,
            child: SafeArea(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onLongPress: () {
                  HapticFeedback.mediumImpact();
                  _settings();
                },
                child: const SizedBox(width: 72, height: 72),
              ),
            ),
          ),
          // What the remote does, for a few seconds after a key.
          Positioned(
            right: 24,
            bottom: 24,
            child: SafeArea(
              child: IgnorePointer(
                child: AnimatedOpacity(
                  opacity: _hint ? 1 : 0,
                  duration: reduce ? Duration.zero : const Duration(milliseconds: 260),
                  curve: _ease,
                  child: _RemoteHint(adverts: _idle && _playing.length > 1),
                ),
              ),
            ),
          ),
        ]),
      ),
      ),
    );
  }
}

/// The remote's keys on this screen, in the brand's lime key caps.
class _RemoteHint extends StatelessWidget {
  const _RemoteHint({required this.adverts});
  final bool adverts;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme.titleSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w600);
    Widget cap(String s) => Container(
          constraints: const BoxConstraints(minWidth: 34),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          alignment: Alignment.center,
          decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(8)),
          child: Text(s, style: const TextStyle(color: Color(0xFF0B0E0A), fontWeight: FontWeight.w800, fontSize: 14)),
        );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xE6171B15),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (adverts) ...[
          cap('◀'),
          const SizedBox(width: 4),
          cap('▶'),
          const SizedBox(width: 10),
          Text('Adverts', style: t),
          const SizedBox(width: 22),
        ],
        cap('OK'),
        const SizedBox(width: 10),
        Text('Settings', style: t),
      ]),
    );
  }
}

class _Advert {
  const _Advert({required this.url, required this.video, required this.seconds, this.file = false});

  /// A web address, or a path on this device when [file].
  final String url;
  final bool video;
  final int seconds;
  final bool file;
}

/// Waiting for a till: the code, in type that can be read across a counter.
class _PairCode extends StatelessWidget {
  const _PairCode({required this.code, required this.venue, required this.linked});
  final String code;
  final String venue;
  final bool linked;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.connected_tv_rounded, size: 64, color: Tp.lime),
            const SizedBox(height: 20),
            Text('Connect this display to a till', textAlign: TextAlign.center, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 10),
            Text(
              'On the till, open Settings › Customer display, and connect the display with this code.',
              textAlign: TextAlign.center,
              style: t.titleMedium?.copyWith(color: Colors.white70),
            ),
            const SizedBox(height: 28),
            Row(mainAxisSize: MainAxisSize.min, children: [
              for (final d in code.split(''))
                Container(
                  width: 76,
                  height: 96,
                  margin: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(18)),
                  child: Text(d, style: t.displayMedium?.copyWith(fontWeight: FontWeight.w900, color: Tp.lime, fontFeatures: Tp.tabular)),
                ),
            ]),
            const SizedBox(height: 24),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: linked ? Tp.lime : const Color(0xFFFF9F0A))),
              const SizedBox(width: 8),
              Text(linked ? 'Waiting for the till${venue.isEmpty ? '' : ' at $venue'}' : 'Reaching the back office…', style: t.bodyMedium?.copyWith(color: Colors.white60)),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// The bill as it is rung up; adverts beside it on a wide screen.
class _Bill extends StatelessWidget {
  const _Bill({required this.basket, required this.control, required this.adverts, required this.venue, this.look = const _Look(), this.showDiscount = true});
  final bool showDiscount;
  final _Look look;
  final Basket basket;
  final TillControl? control;
  final List<_Advert> adverts;
  final String venue;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final c = control;
    final showPrices = c?.showPrices ?? true;
    final size = MediaQuery.sizeOf(context);
    final wide = size.width > size.height && size.width >= 900;
    final lines = basket.lines;
    final bill = SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 24, 28, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(basket.greeting ?? (basket.customerName == null ? (venue.isEmpty ? 'Your order' : venue) : 'Hello ${basket.customerName}'),
              style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          if (basket.customerPoints != null)
            Text('${basket.customerPoints} points', style: t.titleMedium?.copyWith(color: Tp.lime)),
          const SizedBox(height: 16),
          Expanded(
            child: ListView.builder(
              reverse: false,
              itemCount: lines.length,
              itemBuilder: (context, i) {
                final l = lines[i];
                final newest = i == lines.length - 1;
                return TweenAnimationBuilder<double>(
                  key: ValueKey('$i-${l.name}-${l.quantity}'),
                  tween: Tween(begin: newest ? 0 : 1, end: 1),
                  duration: const Duration(milliseconds: 420),
                  curve: _ease,
                  builder: (context, v, child) => Opacity(opacity: v, child: Transform.translate(offset: Offset(0, 12 * (1 - v)), child: child)),
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(l.isModifier ? 40 : 0, 6, 0, 6),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      if (!l.isModifier)
                        SizedBox(
                          width: 48,
                          child: Text(l.quantity == l.quantity.roundToDouble() ? '${l.quantity.toInt()}' : '${l.quantity}',
                              style: t.titleLarge?.copyWith(color: Colors.white60, fontFeatures: Tp.tabular)),
                        ),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(l.name, style: (l.isModifier ? t.titleMedium : t.titleLarge)?.copyWith(color: l.isModifier ? Colors.white70 : Colors.white)),
                          if (l.allergens.isNotEmpty)
                            Text('Contains ${l.allergens.join(', ')}', style: t.bodySmall?.copyWith(color: const Color(0xFFFF9F0A))),
                        ]),
                      ),
                      if (showPrices && !l.isModifier) Text(money(l.totalMinor), style: t.titleLarge?.copyWith(fontFeatures: Tp.tabular)),
                    ]),
                  ),
                );
              },
            ),
          ),
          const Divider(height: 28),
          if (showDiscount && basket.discountMinor > 0) _TotalRow(label: 'Discount', minor: -basket.discountMinor),
          if (basket.paidMinor > 0) _TotalRow(label: 'Paid', minor: basket.paidMinor),
          Row(children: [
            Expanded(child: Text(basket.paidMinor > 0 ? 'Left to pay' : 'Total', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w700))),
            TweenAnimationBuilder<double>(
              tween: Tween(end: (basket.totalMinor - basket.paidMinor).toDouble()),
              duration: const Duration(milliseconds: 380),
              curve: _ease,
              builder: (context, v, _) => Text(money(v.round()),
                  style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900, color: Tp.lime, fontFeatures: Tp.tabular)),
            ),
          ]),
          if ((basket.message ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(basket.message!, style: t.titleMedium)),
        ]),
      ),
    );
    if (!wide || adverts.isEmpty) return bill;
    final share = ((c?.billShare ?? 50).clamp(30, 70)) / 100;
    final ad = _Slides(adverts: adverts, look: look);
    final billBox = Expanded(flex: (share * 100).round(), child: Container(color: const Color(0xFF12160F), child: bill));
    final adBox = Expanded(flex: ((1 - share) * 100).round(), child: ad);
    return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: c?.billOnRight == true ? [adBox, billBox] : [billBox, adBox]);
  }
}

class _TotalRow extends StatelessWidget {
  const _TotalRow({required this.label, required this.minor});
  final String label;
  final int minor;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(children: [
        Expanded(child: Text(label, style: t.titleMedium?.copyWith(color: Colors.white70))),
        Text(money(minor), style: t.titleMedium?.copyWith(fontFeatures: Tp.tabular)),
      ]),
    );
  }
}

/// The card payment, as the customer should see it, and the QR to pay with
/// their own phone when the till offers one.
class _CardScreen extends StatelessWidget {
  const _CardScreen({required this.card, required this.basket, required this.options});
  final CardStatus card;
  final Basket basket;
  final DisplayOptions options;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final colour = card.isResult ? (card.approved ? Tp.lime : (card.uncertain ? const Color(0xFFFF9F0A) : const Color(0xFFFF453A))) : Colors.white;
    final amount = card.amountMinor > 0 ? card.amountMinor : basket.totalMinor - basket.paidMinor;
    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            if (card.heading != null) Text(card.heading!.toUpperCase(), style: t.labelLarge?.copyWith(letterSpacing: 1.4, color: Colors.white60)),
            if (options.showAmount) Text(money(amount), style: t.displayLarge?.copyWith(fontWeight: FontWeight.w900, fontFeatures: Tp.tabular)),
            const SizedBox(height: 24),
            if (card.qr != null && options.showQr)
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(24)),
                child: QrImageView(data: card.qr!, size: min(320, MediaQuery.sizeOf(context).shortestSide * 0.5)),
              )
            else
              Icon(
                card.isResult ? (card.approved ? Icons.check_circle_rounded : Icons.error_rounded) : Icons.contactless_rounded,
                size: 120,
                color: colour,
              ),
            const SizedBox(height: 24),
            Text(card.title, textAlign: TextAlign.center, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800, color: colour)),
            if (card.detail != null && options.showCardSteps)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(card.detail!, textAlign: TextAlign.center, style: t.titleMedium?.copyWith(color: Colors.white70)),
              ),
            if (options.showCardMarks && !card.isResult)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Text('Visa · Mastercard · Maestro · Amex · Apple Pay · Google Pay', textAlign: TextAlign.center, style: t.bodyMedium),
              ),
            if (card.qr != null && options.showQr)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('Scan with your phone\'s camera to pay, tip and get a receipt.', textAlign: TextAlign.center, style: t.bodyLarge?.copyWith(color: Colors.white60)),
              ),
          ]),
        ),
      ),
    );
  }
}

class _ThankYou extends StatelessWidget {
  const _ThankYou({required this.basket, required this.words});
  final Basket basket;
  final String words;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          TweenAnimationBuilder<double>(
            tween: Tween(begin: 0.6, end: 1),
            duration: const Duration(milliseconds: 700),
            curve: Curves.elasticOut,
            builder: (context, v, child) => Transform.scale(scale: v, child: child),
            child: Icon(Icons.favorite_rounded, size: 96, color: Tp.lime),
          ),
          const SizedBox(height: 20),
          Text(words, textAlign: TextAlign.center, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900)),
          if (basket.changeMinor > 0)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Text('Your change: ${money(basket.changeMinor)}', style: t.headlineSmall?.copyWith(color: Tp.lime, fontFeatures: Tp.tabular)),
            ),
        ]),
      ),
    );
  }
}

/// Nothing going on: the adverts, and the venue's name, the time and its
/// standing message and QR along the bottom.
class _Idle extends StatelessWidget {
  const _Idle({
    this.slidesKey,
    required this.adverts,
    this.look = const _Look(),
    required this.venue,
    required this.control,
    this.dim = 0,
    this.onMemberCard,
    this.onScanPass,
  });
  final GlobalKey<_SlidesState>? slidesKey;
  final List<_Advert> adverts;
  final _Look look;
  final String venue;
  final TillControl? control;
  final int dim;
  final VoidCallback? onMemberCard;
  final VoidCallback? onScanPass;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final now = DateTime.now();
    final c = control;
    final band = Container(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 16),
      decoration: const BoxDecoration(
        gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Color(0xCC000000)]),
      ),
      child: SafeArea(
        top: false,
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(venue, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
              if ((c?.standingMessage ?? '').isNotEmpty) Text(c!.standingMessage, style: t.titleMedium?.copyWith(color: Colors.white70)),
            ]),
          ),
          if ((c?.customerQr ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
                  child: QrImageView(data: c!.customerQr, size: 96),
                ),
                const SizedBox(height: 4),
                Text(c.customerQrCaption, style: t.bodySmall),
              ]),
            ),
          Text('${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}',
              style: t.displaySmall?.copyWith(fontWeight: FontWeight.w300, fontFeatures: Tp.tabular)),
        ]),
      ),
    );
    return Stack(children: [
      Positioned.fill(
        child: adverts.isEmpty
            ? Container(
                decoration: const BoxDecoration(
                  gradient: RadialGradient(center: Alignment(0, -0.3), radius: 1.1, colors: [Color(0xFF2A3410), Color(0xFF0B0E0A)]),
                ),
                child: Center(
                  child: Text(venue.isEmpty ? 'Welcome' : venue, textAlign: TextAlign.center,
                      style: t.displayMedium?.copyWith(fontWeight: FontWeight.w900, letterSpacing: -1)),
                ),
              )
            : _Slides(key: slidesKey, adverts: adverts, look: look),
      ),
      if (dim > 0) Positioned.fill(child: IgnorePointer(child: ColoredBox(color: Colors.black.withValues(alpha: dim / 100)))),
      Positioned(
        left: 0,
        right: 0,
        bottom: 0,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (onMemberCard != null)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Wrap(spacing: 12, runSpacing: 8, alignment: WrapAlignment.center, children: [
                FilledButton.icon(onPressed: onMemberCard, icon: const Icon(Icons.nfc_rounded), label: const Text('Tap member card')),
                OutlinedButton.icon(onPressed: onScanPass, icon: const Icon(Icons.qr_code_scanner_rounded), label: const Text('Scan your pass')),
              ]),
            ),
          band,
        ]),
      ),
    ]);
  }
}

/// The adverts, one after another: a picture for its seconds, a film to its end.
/// How the adverts play: seconds a picture stays up (0: its own), film
/// volume, and whether pictures and films fill the screen or sit whole in it.
class _Look {
  const _Look({this.dwell = 0, this.volume = 0, this.fillStills = true, this.fillVideos = true});
  final int dwell;
  final int volume;
  final bool fillStills;
  final bool fillVideos;
}

class _Slides extends StatefulWidget {
  const _Slides({super.key, required this.adverts, this.look = const _Look()});
  final List<_Advert> adverts;
  final _Look look;
  @override
  State<_Slides> createState() => _SlidesState();
}

class _SlidesState extends State<_Slides> {
  int _i = 0;
  Timer? _timer;
  VideoPlayerController? _video;

  @override
  void initState() {
    super.initState();
    _show();
  }

  @override
  void didUpdateWidget(_Slides old) {
    super.didUpdateWidget(old);
    if (old.look.volume != widget.look.volume) unawaited(_video?.setVolume(widget.look.volume.clamp(0, 100) / 100));
    if (old.adverts.length != widget.adverts.length || (widget.adverts.isNotEmpty && old.adverts.isNotEmpty && old.adverts.last.url != widget.adverts.last.url)) {
      _i = 0;
      _show();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _video?.dispose();
    super.dispose();
  }

  Future<void> _show() async {
    _timer?.cancel();
    final old = _video;
    _video = null;
    if (widget.adverts.isEmpty) return;
    final a = widget.adverts[_i % widget.adverts.length];
    if (a.video) {
      final v = a.file ? VideoPlayerController.file(File(a.url)) : VideoPlayerController.networkUrl(Uri.parse(a.url));
      try {
        await v.initialize();
        await v.setVolume(widget.look.volume.clamp(0, 100) / 100);
        if (!mounted) {
          await v.dispose();
          return;
        }
        _video = v;
        v.addListener(() {
          if (v.value.isInitialized && !v.value.isPlaying && v.value.position >= v.value.duration && mounted) _next();
        });
        await v.play();
        // A film that never ends (or never says) still moves on.
        _timer = Timer(v.value.duration + const Duration(seconds: 2), _next);
      } catch (_) {
        await v.dispose();
        _timer = Timer(const Duration(seconds: 1), _next);
      }
    } else {
      _timer = Timer(Duration(seconds: (widget.look.dwell > 0 ? widget.look.dwell : a.seconds).clamp(3, 300)), _next);
    }
    await old?.dispose();
    if (mounted) setState(() {});
  }

  /// The remote's left and right keys.
  void previous() => _previous();
  void next() => _next();

  void _previous() {
    if (!mounted) return;
    _timer?.cancel();
    final count = max(1, widget.adverts.length);
    setState(() => _i = (_i - 1 + count) % count);
    _show();
  }

  void _next() {
    if (!mounted) return;
    _timer?.cancel();
    setState(() => _i = (_i + 1) % max(1, widget.adverts.length));
    _show();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.adverts.isEmpty) return const SizedBox.shrink();
    final a = widget.adverts[_i % widget.adverts.length];
    final v = _video;
    final child = a.video
        ? (v != null && v.value.isInitialized
            ? FittedBox(
                fit: widget.look.fillVideos ? BoxFit.cover : BoxFit.contain,
                child: SizedBox(width: v.value.size.width, height: v.value.size.height, child: VideoPlayer(v)),
              )
            : const ColoredBox(color: Colors.black))
        : (a.file
            ? Image.file(File(a.url), fit: widget.look.fillStills ? BoxFit.cover : BoxFit.contain, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black))
            : Image.network(a.url, fit: widget.look.fillStills ? BoxFit.cover : BoxFit.contain, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black)));
    // A customer can swipe through them, either way.
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onHorizontalDragEnd: (e) {
        final speed = e.primaryVelocity ?? 0;
        if (speed < -100) _next();
        if (speed > 100) _previous();
      },
      child: ClipRect(
      child: AnimatedSwitcher(
        duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 900),
        child: SizedBox.expand(key: ValueKey('$_i-${a.url}-${v != null}'), child: child),
      ),
      ),
    );
  }
}

/// The tiles: the Windows display's clock, date, welcome, special, QR, cards
/// and total, as a strip along the bottom or a column down the side. Glass
/// panels over the screen's own dark, the brand's lime for what matters.
class _WithTiles extends StatelessWidget {
  const _WithTiles({required this.tiles, required this.side, required this.control, required this.basket, required this.venue, required this.child});
  final List<String> tiles;
  final bool side;
  final TillControl control;
  final Basket basket;
  final String venue;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final now = DateTime.now();
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    final due = basket.totalMinor - basket.paidMinor;

    Widget? tile(String id) {
      switch (id) {
        case 'clock':
          return _Tile(child: Text('${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}',
              style: t.displaySmall?.copyWith(fontWeight: FontWeight.w300, fontFeatures: Tp.tabular)));
        case 'date':
          return _Tile(
            label: days[now.weekday - 1],
            child: Text('${now.day} ${months[now.month - 1]}', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
          );
        case 'welcome':
          final words = control.welcomeText.isNotEmpty ? control.welcomeText : (venue.isEmpty ? 'Welcome' : 'Welcome to $venue');
          return _Tile(fit: false, child: Text(words, maxLines: 3, overflow: TextOverflow.ellipsis, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)));
        case 'special':
          if (control.specialTitle.isEmpty && control.specialText.isEmpty) return null;
          return _Tile(
            label: control.specialTitle.isEmpty ? "Today's special" : control.specialTitle,
            accent: true,
            fit: false,
            child: Text(control.specialText, maxLines: 4, overflow: TextOverflow.ellipsis, style: t.titleMedium),
          );
        case 'qr':
          if (control.customerQr.isEmpty) return null;
          return _Tile(
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(
                padding: const EdgeInsets.all(5),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
                child: QrImageView(data: control.customerQr, size: 76),
              ),
              const SizedBox(width: 12),
              Flexible(child: Text(control.customerQrCaption, maxLines: 3, style: t.titleSmall)),
            ]),
          );
        case 'cards':
          return _Tile(
            label: 'We take',
            child: Text('Visa · Mastercard · Amex\nApple Pay · Google Pay', style: t.titleSmall?.copyWith(height: 1.35)),
          );
        case 'total':
          if (!basket.hasSale || due <= 0) return null;
          return _Tile(
            label: basket.paidMinor > 0 ? 'Left to pay' : 'Total',
            accent: true,
            child: Text(money(due), style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900, color: Tp.lime, fontFeatures: Tp.tabular)),
          );
      }
      return null;
    }

    final shown = [for (final id in tiles) ?tile(id)];
    if (shown.isEmpty) return child;
    if (side) {
      return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(child: child),
        Container(
          width: 300,
          color: const Color(0xFF0B0E0A),
          padding: const EdgeInsets.fromLTRB(0, 16, 16, 16),
          child: SafeArea(
            left: false,
            child: Column(children: [
              for (final w in shown) Expanded(child: Padding(padding: const EdgeInsets.only(bottom: 12), child: w)),
            ]),
          ),
        ),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Expanded(child: child),
      Container(
        height: 136,
        color: const Color(0xFF0B0E0A),
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: SafeArea(
          top: false,
          child: Row(children: [
            for (var i = 0; i < shown.length; i++) ...[
              if (i > 0) const SizedBox(width: 12),
              Expanded(child: shown[i]),
            ],
          ]),
        ),
      ),
    ]);
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.child, this.label, this.accent = false, this.fit = true});
  final Widget child;
  final bool fit;
  final String? label;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
      decoration: BoxDecoration(
        color: const Color(0xFF171B15),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: accent ? Tp.lime.withValues(alpha: 0.55) : Colors.white.withValues(alpha: 0.08)),
      ),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (label != null)
          Text(label!.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis,
              style: t.labelMedium?.copyWith(letterSpacing: 1.2, color: accent ? Tp.lime : Colors.white60, fontWeight: FontWeight.w700)),
        if (label != null) const SizedBox(height: 4),
        if (fit) FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: child) else Flexible(child: child),
      ]),
    );
  }
}

class _Centre extends StatelessWidget {
  const _Centre({required this.icon, required this.title, required this.words, this.action});
  final IconData icon;
  final String title;
  final String words;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 56, color: Colors.white38),
            const SizedBox(height: 14),
            Text(title, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(words, textAlign: TextAlign.center, style: t.bodyLarge?.copyWith(color: Colors.white60)),
            if (action != null) ...[const SizedBox(height: 18), action!],
          ]),
        ),
      ),
    );
  }
}

/// The customer's view of a bill, and of a display waiting for its till, as
/// [DisplayModePage] draws them, without a till or the back office: for the
/// Play store's Android TV pictures (store_shots/tv_shots_test.dart).
@visibleForTesting
Widget displayPreview({Basket? basket, String venue = '', String code = '4827'}) => Theme(
      data: Tp.theme(Brightness.dark),
      child: Scaffold(
        backgroundColor: const Color(0xFF0B0E0A),
        body: basket == null
            ? _PairCode(code: code, venue: venue, linked: true)
            : _Bill(basket: basket, control: null, adverts: const [], venue: venue),
      ),
    );
