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
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:qr_flutter/qr_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'dart:convert';

import '../../config/constants.dart';
import '../../data/api.dart';
import '../../data/models.dart' show money;
import '../../data/session.dart';
import '../../modes/mode_settings.dart';
import '../../data/lan/lan_service.dart';
import '../../ui/pages/connection_page.dart';
import '../../ui/sounds.dart';
import '../../ui/theme.dart';
import '../data/basket_feed.dart';
import '../data/control.dart';
import '../data/display_options.dart';
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
  Timer? _tick;
  Timer? _status;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable().catchError((Object _) {});
    DisplayOptions.load().then((o) {
      if (mounted) setState(() => _options = o);
    });
    // The display, not the till, is on the venue's link now.
    TapSession.lanHeldByDisplay = true;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  @override
  void dispose() {
    _tick?.cancel();
    _status?.cancel();
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
  }

  void _sendStatus() {
    final size = MediaQuery.maybeSizeOf(context);
    _link?.sendStatus(DisplayStatusReport(
      appVersion: 'Vesopa Go',
      following: _paidTo ?? '',
      advertCount: _adverts.length,
      width: size?.width.round() ?? 0,
      height: size?.height.round() ?? 0,
      link: _link?.route ?? 'cloud',
    ).toJson());
  }

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

  bool get _idle {
    final c = _control;
    if (_basket.card != null) return false;
    if (_basket.state == 'paid') {
      return DateTime.now().difference(_lastChange) > Duration(seconds: _options.thanksSeconds > 0 ? _options.thanksSeconds : c?.thankYouSeconds ?? 20);
    }
    if (_basket.hasSale) return false;
    return DateTime.now().difference(_lastChange) > Duration(seconds: min(c?.idleSeconds ?? 45, 10));
  }

  Future<void> _settings() async {
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
    setState(() => _options = o);
    await o.save();
  }

  /// What a manager can change here, after their PIN.
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
      Widget flag(String title, String detail, bool value, DisplayOptions Function(bool) change) => SwitchListTile(
        title: Text(title),
        subtitle: Text(detail),
        value: value,
        onChanged: (v) => set(change(v)),
      );
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          flag('Touch', 'Off: customers cannot touch anything on this screen.', o.touch, (v) => o.copyWith(touch: v)),
          flag('Sound', 'A chime when a payment is approved or declined.', o.sound, (v) => o.copyWith(sound: v)),
          flag('Pay from a phone', 'Show the QR code when the till offers it.', o.showQr, (v) => o.copyWith(showQr: v)),
          flag('Amount to pay', 'The amount in big figures on the pay screen.', o.showAmount, (v) => o.copyWith(showAmount: v)),
          flag('Card steps', 'What the card is doing, as the till words it.', o.showCardSteps, (v) => o.copyWith(showCardSteps: v)),
          flag('Cards we take', 'Card and wallet names under the pay screen.', o.showCardMarks, (v) => o.copyWith(showCardMarks: v)),
          flag('Discounts', 'Discounts and savings on the bill.', o.showDiscount, (v) => o.copyWith(showDiscount: v)),
          ListTile(
            title: const Text('Thank-you stays up for'),
            subtitle: Text(o.thanksSeconds == 0 ? 'What the till says' : '${o.thanksSeconds} seconds'),
          ),
          Slider(
            value: o.thanksSeconds.toDouble(),
            max: 60,
            divisions: 12,
            label: '${o.thanksSeconds}',
            onChanged: (v) => set(o.copyWith(thanksSeconds: v.round())),
          ),
          const ListTile(title: Text('Size of the words')),
          Slider(
            value: o.textScale,
            min: 0.8,
            max: 1.6,
            divisions: 8,
            label: o.textScale.toStringAsFixed(1),
            onChanged: (v) => set(o.copyWith(textScale: v)),
          ),
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
        ConnRow(Icons.slideshow_rounded, 'Adverts', _adverts.isEmpty ? 'None (back office > Devices > Customer display adverts)' : '${_adverts.length} playing when idle', neutral: true),
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
      screen = _Idle(adverts: _adverts, venue: venue, control: _control);
    } else if (_basket.state == 'paid') {
      screen = _ThankYou(basket: _basket, words: _control?.thankYou ?? 'Thank you');
    } else {
      screen = _Bill(basket: _basket, control: _control, adverts: _adverts, venue: venue, showDiscount: _options.showDiscount);
    }
    return Scaffold(
      backgroundColor: const Color(0xFF0B0E0A),
      body: Theme(
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
                key: ValueKey(screen.runtimeType),
                // The corner below stays live, so staff are never locked out.
                child: AbsorbPointer(
                  absorbing: !_options.touch,
                  child: MediaQuery(
                    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(_options.textScale)),
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
        ]),
      ),
    );
  }
}

class _Advert {
  const _Advert({required this.url, required this.video, required this.seconds});
  final String url;
  final bool video;
  final int seconds;
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
            const Icon(Icons.connected_tv_rounded, size: 64, color: Tp.lime),
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
  const _Bill({required this.basket, required this.control, required this.adverts, required this.venue, this.showDiscount = true});
  final bool showDiscount;
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
    final ad = _Slides(adverts: adverts);
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
            child: const Icon(Icons.favorite_rounded, size: 96, color: Tp.lime),
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
  const _Idle({required this.adverts, required this.venue, required this.control});
  final List<_Advert> adverts;
  final String venue;
  final TillControl? control;

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
            : _Slides(adverts: adverts),
      ),
      Positioned(left: 0, right: 0, bottom: 0, child: band),
    ]);
  }
}

/// The adverts, one after another: a picture for its seconds, a film to its end.
class _Slides extends StatefulWidget {
  const _Slides({required this.adverts});
  final List<_Advert> adverts;
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
    if (old.adverts.length != widget.adverts.length) {
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
      final v = VideoPlayerController.networkUrl(Uri.parse(a.url));
      try {
        await v.initialize();
        await v.setVolume(0);
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
      _timer = Timer(Duration(seconds: a.seconds.clamp(3, 120)), _next);
    }
    await old?.dispose();
    if (mounted) setState(() {});
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
            ? FittedBox(fit: BoxFit.cover, child: SizedBox(width: v.value.size.width, height: v.value.size.height, child: VideoPlayer(v)))
            : const ColoredBox(color: Colors.black))
        : Image.network(a.url, fit: BoxFit.cover, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black));
    return ClipRect(
      child: AnimatedSwitcher(
        duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 900),
        child: SizedBox.expand(key: ValueKey('$_i-${a.url}-${v != null}'), child: child),
      ),
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
