/// Vesopa Go on a phone or tablet as the remote for the venue's TVs (owner,
/// 2026-11-19: "Add options to the Vesopa Go mobile app properly to control
/// the TV kitchen and TV customer display").
///
/// A screen (Kitchen or Customer display) says it is here every ten seconds
/// ([ScreenBeacon]); a phone lists the screens and presses keys on one
/// (lib/remote/remote_page.dart); the back office passes each key at once
/// over the venue's live connection as `go.remote` (vesopa_server
/// src/go_remote.js), and the screen with that id acts on it here, as if its
/// own remote had been pressed.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show FlutterView;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config/constants.dart';
import '../data/lan/lan_service.dart';

import '../ui/go_frame.dart';
import '../ui/tv.dart';

class GoRemote {
  GoRemote._();

  /// A page that knows better than the default what a key means (the
  /// customer display's adverts, its settings): answers true when it took it.
  static final _handlers = <bool Function(String key)>[];

  static void listen(bool Function(String key) handler) => _handlers.add(handler);
  static void forget(bool Function(String key) handler) => _handlers.remove(handler);

  /// Keys already acted on, by the phone's id for them: one sent over the
  /// venue's local network and through the back office is pressed once.
  static final _seen = <String>[];

  /// This screen's id, once a Kitchen or Customer display page is open.
  static String? myId;

  /// When the last key arrived, and how (Local: the venue's own network;
  /// Live: through the back office).
  static DateTime? lastKeyAt;
  static String lastVia = '';

  /// A message from the phone, by either road: `{device_id, key, id?,
  /// index?, text?}`.
  static void receive(Map<String, dynamic> msg, {required String via}) {
    final to = '${msg['device_id'] ?? ''}';
    if (myId == null || to != myId) return;
    final id = '${msg['id'] ?? ''}';
    if (id.isNotEmpty) {
      if (_seen.contains(id)) return;
      _seen.add(id);
      if (_seen.length > 64) _seen.removeAt(0);
    }
    lastKeyAt = DateTime.now();
    lastVia = via;
    final index = msg['index'] is num ? (msg['index'] as num).toInt() : null;
    final text = msg['text'] is String ? msg['text'] as String : null;
    press('${msg['key'] ?? ''}', index: index, text: text);
  }

  static bool _lanJoined = false;

  /// Keys over the venue's own network as well as the back office (owner,
  /// 2026-11-27: "use local network first and then real IP").
  static void listenLocal() {
    if (_lanJoined) return;
    _lanJoined = true;
    LanService.instance.subscribe('go.remote', (m) {
      final d = m.data;
      if (d is Map) receive(Map<String, dynamic>.from(d), via: 'local');
    });
  }

  static const _device = MethodChannel('com.vesopa.go/device');

  /// A key from the phone. The page on top gets it first; else the arrows
  /// move the focus, OK presses what has it and Back goes back, exactly as
  /// the TV's own remote does.
  static void press(String key, {int? index, String? text}) {
    // The remote is in use: draw the focus as the TV's own remote would.
    FocusManager.instance.highlightStrategy = FocusHighlightStrategy.alwaysTraditional;
    if (!GoDevice.remote.value) GoDevice.remote.value = true;
    // A blanked screen wakes on any key but power, which it toggles.
    if (key == 'power') {
      GoDevice.screenOff.value = !GoDevice.screenOff.value;
      ScreenMirror.current?.changed();
      return;
    }
    if (GoDevice.screenOff.value) {
      GoDevice.screenOff.value = false;
      if (key != 'ok') return;
    }
    switch (key) {
      case 'mute' || 'volume_up' || 'volume_down':
        unawaited(_device
            .invokeMapMethod<String, Object?>('volume', {'action': key == 'mute' ? 'mute' : (key == 'volume_up' ? 'up' : 'down')})
            .then((v) => ScreenMirror.current?.volume(v))
            .catchError((Object _) => null));
        return;
      case 'tap':
        if (index != null) ScreenMirror.current?.tap(index);
        return;
      case 'text':
        if (text != null) ScreenMirror.current?.type(text, index: index);
        return;
      case 'submit':
        ScreenMirror.current?.submit();
        return;
      case 'home':
        // Every sheet, dialog and page off the screen: back to the board or
        // the adverts.
        goNavigator.currentState?.popUntil((r) => r.isFirst);
        ScreenMirror.current?.changed();
        return;
    }
    for (final h in _handlers.reversed.toList()) {
      if (h(key)) {
        ScreenMirror.current?.changed();
        return;
      }
    }
    final direction = switch (key) {
      'up' => TraversalDirection.up,
      'down' => TraversalDirection.down,
      'left' => TraversalDirection.left,
      'right' => TraversalDirection.right,
      _ => null,
    };
    if (direction != null) {
      // Nothing focused yet: the first item on the page takes it.
      if (!GoDevice.focusSomething()) {
        final c = FocusManager.instance.primaryFocus?.context;
        // Through the app's own action, so the list scrolls to what is
        // focused (ui/tv.dart), as the TV's remote does.
        if (c != null && Actions.maybeInvoke(c, DirectionalFocusIntent(direction)) == null) {
          FocusManager.instance.primaryFocus?.focusInDirection(direction);
        }
      }
    } else if (key == 'ok') {
      if (!GoDevice.focusSomething()) {
        final c = FocusManager.instance.primaryFocus?.context;
        if (c != null) Actions.maybeInvoke(c, const ActivateIntent());
      }
    } else if (key == 'back') {
      goNavigator.currentState?.maybePop();
    }
    ScreenMirror.current?.changed();
  }
}

/// What this screen shows, for the phone's remote (owner, 2026-11-27: "show
/// in the suggestion box like keyboard ... wherever we are show that
/// interactively in the Vesopa Go"): the page, every button, tab, setting and
/// text box on it, and which has the focus. Sent over the venue's local
/// network at once and to the back office, whenever it changes. The phone
/// presses item n ([tap]) or types into it ([type]).
class ScreenMirror {
  ScreenMirror({required this.deviceId, required this.name, required this.mode, required this.post});

  final String deviceId;
  final String Function() name;
  final String mode;

  /// To the back office: the state, when the local network is not there.
  final Future<void> Function(Map<String, Object?> state) post;

  static ScreenMirror? current;

  /// No posting to a back office from widget tests.
  static final bool _underTest = Platform.environment['FLUTTER_TEST'] == 'true';

  Timer? _timer;
  String _last = '';
  DateTime _posted = DateTime.fromMillisecondsSinceEpoch(0);
  List<FocusNode> _nodes = const [];
  Map<String, Object?>? _volume;

  void start() {
    current = this;
    GoRemote.myId = deviceId;
    GoRemote.listenLocal();
    FocusManager.instance.addListener(changed);
    _timer = Timer.periodic(const Duration(milliseconds: 900), (_) => _send());
    changed();
  }

  void stop() {
    _timer?.cancel();
    FocusManager.instance.removeListener(changed);
    if (current == this) current = null;
  }

  bool _queued = false;

  /// Something moved: send the new state after this frame.
  void changed() {
    if (_queued) return;
    _queued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _queued = false;
      _send();
    });
  }

  void volume(Map<String, Object?>? v) {
    _volume = v;
    changed();
  }

  void _send() {
    if (current != this) return;
    final state = snapshot();
    final json = jsonEncode(state);
    final now = DateTime.now();
    final fresh = json != _last;
    if (fresh) {
      _last = json;
      LanService.instance.publish('go.screen', state, key: deviceId);
    }
    // The back office hears every change, and every 8 s regardless, so a
    // phone on mobile data still sees it.
    if (!_underTest && (fresh || now.difference(_posted) > const Duration(seconds: 8))) {
      _posted = now;
      unawaited(Future<void>(() => post(state)).catchError((Object _) {}));
    }
  }

  Map<String, Object?> snapshot() {
    final scope = GoDevice.topScope();
    final focus = FocusManager.instance.primaryFocus;
    final view = WidgetsBinding.instance.platformDispatcher.views.firstOrNull;
    final screen = view == null ? Size.infinite : view.physicalSize / view.devicePixelRatio;
    final nodes = <FocusNode>[];
    final items = <Map<String, Object?>>[];
    for (final n in scope?.traversalDescendants ?? const <FocusNode>[]) {
      if (items.length >= 80) break;
      if (n is FocusScopeNode || !n.canRequestFocus) continue;
      final c = n.context;
      if (c == null || !c.mounted) continue;
      final box = c.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize || box.size.isEmpty) continue;
      final at = box.localToGlobal(Offset.zero);
      final onScreen = at.dx < screen.width && at.dy < screen.height && at.dx + box.size.width > 0 && at.dy + box.size.height > 0;
      final d = _describe(c);
      if (d.label.isEmpty && d.kind != 'text') continue;
      nodes.add(n);
      items.add({
        'l': d.label,
        'k': d.kind,
        if (d.value != null) 'v': d.value,
        if (n == focus || n.hasPrimaryFocus) 'f': true,
        if (!onScreen) 'o': true,
      });
    }
    _nodes = nodes;
    final top = goNavigator.currentState;
    return {
      'name': name(),
      'mode': mode,
      'page': _pageTitle(),
      'open': ModalRoute.of(focus?.context ?? top?.context ?? WidgetsBinding.instance.rootElement!)?.isFirst == false,
      'items': items,
      'off': GoDevice.screenOff.value,
      if (_volume != null) 'volume': _volume,
      'via': GoRemote.lastVia,
      'device': _device(screen, view),
    };
  }

  /// About this screen: what the phone shows under the remote's More.
  Map<String, Object?> _device(Size screen, FlutterView? view) => {
        ...GoDevice.details,
        'id': deviceId,
        'name': name(),
        if (view != null) 'pixels': '${view.physicalSize.width.round()} × ${view.physicalSize.height.round()}',
        if (view != null) 'density': view.devicePixelRatio,
        'tv': GoDevice.isTv,
        'app': goAppVersion,
      };

  String _pageTitle() {
    final c = FocusManager.instance.primaryFocus?.context;
    final route = c == null ? null : ModalRoute.of(c);
    if (route == null || route.isFirst) return mode == 'kitchen' ? 'Kitchen' : 'Customer display';
    if (route is PopupRoute) return 'Menu';
    return route.settings.name ?? 'Page';
  }

  /// Press item [i]: the focus moves there, and it is pressed, as OK would.
  void tap(int i) {
    if (i < 0 || i >= _nodes.length) return;
    final n = _nodes[i];
    final c = n.context;
    if (c == null || !c.mounted) return;
    n.requestFocus();
    Scrollable.ensureVisible(c, alignment: 0.5, duration: const Duration(milliseconds: 150));
    if (_describe(c).kind != 'text') Actions.maybeInvoke(c, const ActivateIntent());
    changed();
  }

  /// Type [text] into item [index], or into whatever has the focus.
  void type(String text, {int? index}) {
    FocusNode? n = index != null && index >= 0 && index < _nodes.length ? _nodes[index] : FocusManager.instance.primaryFocus;
    final c = n?.context;
    if (c == null || !c.mounted) return;
    final editor = _editorIn(c);
    if (editor == null) return;
    if (index != null) n!.requestFocus();
    editor.userUpdateTextEditingValue(
      TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length)),
      SelectionChangedCause.keyboard,
    );
    changed();
  }

  /// Done on the phone's keyboard: the field's own action (next, done, go).
  void submit() {
    final c = FocusManager.instance.primaryFocus?.context;
    if (c == null) return;
    final editor = _editorIn(c);
    editor?.performAction(editor.widget.textInputAction ?? TextInputAction.done);
    changed();
  }

  static EditableTextState? _editorIn(BuildContext c) {
    if (c is StatefulElement && c.state is EditableTextState) return c.state as EditableTextState;
    final up = c.findAncestorStateOfType<EditableTextState>();
    if (up != null) return up;
    EditableTextState? found;
    void visit(Element e) {
      if (found != null) return;
      if (e is StatefulElement && e.state is EditableTextState) {
        found = e.state as EditableTextState;
        return;
      }
      e.visitChildren(visit);
    }
    (c as Element).visitChildren(visit);
    return found;
  }

  /// What a focusable thing says on it, and what kind of thing it is.
  static ({String label, String kind, String? value}) _describe(BuildContext c) {
    final editor = _editorIn(c);
    if (editor != null && (c.widget is EditableText || c.findAncestorStateOfType<EditableTextState>() != null || _small(c))) {
      final dec = c.findAncestorWidgetOfExactType<InputDecorator>()?.decoration;
      final w = editor.widget;
      final shown = w.obscureText ? '•' * w.controller.text.length : w.controller.text;
      return (label: dec?.labelText ?? dec?.hintText ?? 'Text', kind: 'text', value: shown);
    }
    final words = <String>[];
    String kind = 'button';
    String? value;
    var budget = 600;
    void add(String? t) {
      final v = (t ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();
      if (v.isNotEmpty && !words.contains(v) && words.length < 3) words.add(v);
    }
    void visit(Element e) {
      if (--budget <= 0 || words.length >= 3) return;
      final w = e.widget;
      if (w is Text) {
        add(w.data ?? w.textSpan?.toPlainText());
      } else if (w is RichText) {
        add(w.text.toPlainText());
      } else if (w is Tooltip) {
        add(w.message);
      } else if (w is Switch) {
        kind = 'toggle';
        value = w.value ? 'On' : 'Off';
      } else if (w is Checkbox) {
        kind = 'toggle';
        value = w.value == true ? 'On' : 'Off';
      } else if (w is Semantics && w.properties.label != null) {
        add(w.properties.label);
      }
      e.visitChildren(visit);
    }
    visit(c as Element);
    if (words.isEmpty) {
      // An icon button: its tooltip sits above it.
      add(c.findAncestorWidgetOfExactType<Tooltip>()?.message);
    }
    return (label: words.join(' · '), kind: kind, value: value);
  }

  static bool _small(BuildContext c) {
    final b = c.findRenderObject();
    return b is RenderBox && b.hasSize && b.size.height < 140;
  }
}

/// While a screen is open: "I am here" to the back office every ten
/// seconds, so the phone's remote can find it.
class ScreenBeacon {
  ScreenBeacon(this._hello);

  final Future<void> Function() _hello;
  Timer? _timer;

  void start() {
    unawaited(_beat());
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => unawaited(_beat()));
  }

  Future<void> _beat() async {
    try {
      await _hello();
    } catch (_) {
      // Offline for a moment: the next beat says it again.
    }
  }

  void stop() => _timer?.cancel();

  static bool get isTv => GoDevice.isTv;
}
