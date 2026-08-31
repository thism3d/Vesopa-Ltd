/// Setting the screen up.
///
/// Reached from a deliberately faint cog in the corner of the display. This is
/// the only screen in the application anybody types into, and it is used once,
/// on the day the display is mounted — so it says what each setting does rather
/// than assuming somebody will find out.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';

import '../data/adverts.dart';
import '../data/control.dart';
import '../data/screens.dart';
import '../data/settings.dart';
import 'theme.dart';

class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends ConsumerState<SettingsPage> {
  final _basket = TextEditingController();
  final _adverts = TextEditingController();
  final _thanks = TextEditingController();
  int _idle = 45;
  int _dwell = 12;
  bool _prices = true;
  bool _loaded = false;

  /// Whether the manager has asked to type a path instead of letting this
  /// screen find the till. Off unless a path was already stored, which is the
  /// only way one gets there.
  bool _override = false;

  String _screenKey = '';
  bool _fullScreen = true;

  /// The monitors attached, re-read whenever this page is opened. A screen
  /// plugged in after the display was set up should appear without restarting
  /// anything — on install day the cable goes in while the software is running
  /// at least as often as before.
  List<Screen> _screens = const [];
  bool _screensRead = false;

  @override
  void initState() {
    super.initState();
    unawaited(_readScreens());
  }

  /// Whether the till is setting this screen up.
  ///
  /// When it is, the sections below are hidden rather than shown disabled. A
  /// greyed-out slider still invites somebody to try to move it; a sentence
  /// saying where the setting actually lives does not.
  bool get _tillOwnsSettings =>
      isControlledByTill(_basket.text.trim().isNotEmpty
          ? _basket.text.trim()
          : (defaultBasketPath() ?? ''));

  Future<void> _readScreens() async {
    final screens = await listScreens();
    if (!mounted) return;
    setState(() {
      _screens = screens;
      _screensRead = true;
    });
  }

  @override
  void dispose() {
    _basket.dispose();
    _adverts.dispose();
    _thanks.dispose();
    super.dispose();
  }

  void _fill(DisplaySettings settings) {
    if (_loaded) return;
    _loaded = true;
    _basket.text = settings.basketPath;
    _override = settings.basketPath.trim().isNotEmpty;
    _adverts.text = settings.advertFolder;
    _thanks.text = settings.thankYou;
    _idle = settings.idleSeconds;
    _dwell = settings.dwellSeconds;
    _prices = settings.showPrices;
    _screenKey = settings.screenKey;
    _fullScreen = settings.fullScreen;
  }

  /// Move the window as soon as the choice is made, rather than on Save.
  ///
  /// This is the only setting on this page whose effect cannot be described in
  /// a sentence — "Screen 2" means nothing until the manager sees the window
  /// land on the monitor facing the customer. Applying it immediately turns the
  /// list into the identify button it would otherwise need.
  Future<void> _applyScreen() async {
    await placeWindow(screenKey: _screenKey, fullScreen: _fullScreen);
  }

  Future<void> _save() async {
    final current = ref.read(displaySettingsProvider).value ?? const DisplaySettings();
    await ref.read(displaySettingsProvider.notifier).save(
      current.copyWith(
        basketPath: _basket.text.trim(),
        advertFolder: _adverts.text.trim(),
        idleSeconds: _idle,
        dwellSeconds: _dwell,
        showPrices: _prices,
        screenKey: _screenKey,
        fullScreen: _fullScreen,
        thankYou: _thanks.text.trim().isEmpty ? 'Thank you' : _thanks.text.trim(),
      ),
    );
    if (mounted) Navigator.of(context).pop();
  }

  /// What the display is following, and how it found it.
  ///
  /// The point of this paragraph is that nobody should have to type a path. It
  /// says which of the three tiers answered, so a support call can be "it says
  /// it found the till automatically" rather than a reading of a path down the
  /// phone.
  String _basketState() {
    final typed = _basket.text.trim();
    final path = typed.isNotEmpty ? typed : (defaultBasketPath() ?? '');

    if (path.isEmpty) {
      return 'No till found on this PC, and nothing typed in. Start Vesopa '
          'EPOS on this machine and this will fill itself in.';
    }

    final how = typed.isNotEmpty
        ? 'Set by hand.'
        : announcedBasketPath() == path
        ? 'Found automatically — the till on this PC says this is where it '
              'writes.'
        : 'Found automatically, by looking for the till on this PC.';

    final file = File(path);
    if (!file.existsSync()) {
      return '$how\n$path\n\nNothing there yet. The till writes it when it '
          'opens a bill, so this is normal before the till has been started.';
    }

    final age = DateTime.now().difference(file.lastModifiedSync());
    if (age.inMinutes < 2) {
      return '$how\n$path\n\nConnected - the till is writing to it now.';
    }
    return '$how\n$path\n\nLast written ${_ago(age)} ago.';
  }

  /// How many adverts the chosen folder actually has.
  String _advertState() {
    final path = _adverts.text.trim();
    if (path.isEmpty) {
      return 'No folder chosen, so the screen will show the Vesopa card '
          'instead of adverts.';
    }
    final folder = Directory(path);
    if (!folder.existsSync()) return 'That folder does not exist.';
    final found = advertsIn(folder);
    if (found.isEmpty) {
      return 'That folder has no pictures or clips in it. PNG, JPG, GIF, WEBP, '
          'MP4 and MOV are played; anything else is ignored.';
    }
    final videos = found.where((a) => a.kind == AdvertKind.video).length;
    return '${found.length} advert${found.length == 1 ? '' : 's'} found'
        '${videos > 0 ? ', $videos of them video' : ''}. They play in file-name '
        'order, so name them 01, 02, 03 to set the order.';
  }

  static String _ago(Duration d) {
    if (d.inHours >= 24) return '${d.inDays} day${d.inDays == 1 ? '' : 's'}';
    if (d.inHours >= 1) return '${d.inHours} hour${d.inHours == 1 ? '' : 's'}';
    return '${d.inMinutes} minute${d.inMinutes == 1 ? '' : 's'}';
  }

  /// Ask before quitting.
  ///
  /// The window has no close button, so this is the only way to stop the
  /// application — which also means a mis-tap here is the difference between a
  /// customer display and a black screen nobody notices until somebody
  /// complains. The till asks the same question in the same place.
  Future<void> _confirmExit() async {
    final quit = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(
          Icons.power_settings_new,
          size: 30,
          color: Color(0xFFE0575B),
        ),
        title: const Text('Exit Vesopa Customer Display?'),
        content: const Text(
          'The customer will see whatever is behind this window until it is '
          'started again. The till is not affected.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep it running'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFE0575B),
            ),
            child: const Text('Exit'),
          ),
        ],
      ),
    );

    if (quit != true) return;

    // destroy(), not close(): a full-screen window with no title bar has had no
    // close request to honour, and destroy() tears it down regardless. exit(0)
    // is the backstop if the platform channel is not there for any reason.
    try {
      await windowManager.destroy();
    } catch (_) {
      exit(0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(displaySettingsProvider).value;
    if (settings == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    _fill(settings);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Customer display settings'),
        actions: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: FilledButton(onPressed: _save, child: const Text('Save')),
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              _Section(
                title: 'The till',
                blurb:
                    'This finds Vesopa EPOS on this PC by itself, and keeps '
                    'looking until it does. There is nothing to fill in unless '
                    'the till is on a different machine.',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _Note(_basketState()),
                    const SizedBox(height: 14),
                    if (!_override)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton.icon(
                          icon: const Icon(Icons.edit_outlined, size: 18),
                          label: const Text('Point it somewhere else'),
                          onPressed: () => setState(() => _override = true),
                        ),
                      )
                    else ...[
                      TextField(
                        controller: _basket,
                        onChanged: (_) => setState(() {}),
                        style: const TextStyle(fontFamily: 'Consolas'),
                        decoration: InputDecoration(
                          labelText: "The till's basket file",
                          hintText: defaultBasketPath() ?? '',
                          suffixIcon: IconButton(
                            icon: const Icon(Icons.auto_fix_high),
                            tooltip: 'Go back to finding it automatically',
                            onPressed: () => setState(() {
                              _basket.text = '';
                              _override = false;
                            }),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      const _Note(
                        'Only for a display on a different PC from its till, '
                        'reading the folder over a share. Leave it empty and '
                        'this screen finds the till on its own.',
                      ),
                    ],
                  ],
                ),
              ),

              if (_tillOwnsSettings)
                _Section(
                  title: 'Set up on the till',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: const [
                      _Note(
                        'This screen is being set up from Vesopa EPOS. Open '
                        'Settings there and choose Customer display: the '
                        'monitor, full screen, the adverts, the idle time and '
                        'what the customer reads are all on that page, and '
                        'changes appear here within a couple of seconds.',
                      ),
                      SizedBox(height: 10),
                      _Note(
                        'They are not repeated here on purpose. Two places to '
                        'change one setting is one place too many.',
                      ),
                    ],
                  ),
                ),

              if (!_tillOwnsSettings)
                _Section(
                  title: 'Which screen',
                blurb:
                    'The till and this display are two windows on one PC. This '
                    'is the monitor the customer can see — choosing it moves '
                    'the window there now, so you can check you have the right '
                    'one before you save.',
                child: _ScreenChooser(
                  screens: _screens,
                  read: _screensRead,
                  chosen: _screenKey,
                  fullScreen: _fullScreen,
                  onChosen: (key) {
                    setState(() => _screenKey = key);
                    unawaited(_applyScreen());
                  },
                  onFullScreen: (on) {
                    setState(() => _fullScreen = on);
                    unawaited(_applyScreen());
                  },
                ),
              ),

              if (!_tillOwnsSettings)
                _Section(
                  title: 'Adverts',
                blurb:
                    'A folder on this machine. Drop pictures or clips into it '
                    'and they appear here — nothing needs restarting.',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _adverts,
                      onChanged: (_) => setState(() {}),
                      style: const TextStyle(fontFamily: 'Consolas'),
                      decoration: const InputDecoration(
                        labelText: 'Advert folder',
                        hintText: r'D:\Vesopa\Adverts',
                      ),
                    ),
                    const SizedBox(height: 8),
                    _Note(_advertState()),
                    const SizedBox(height: 18),
                    _Slider(
                      label: 'Each picture stays up for',
                      value: _dwell.toDouble(),
                      min: 3,
                      max: 60,
                      suffix: '$_dwell seconds',
                      onChanged: (v) => setState(() => _dwell = v.round()),
                    ),
                    const _Note(
                      'A clip always plays to its end, whatever this says.',
                    ),
                  ],
                ),
              ),

              if (!_tillOwnsSettings)
                _Section(
                  title: 'When the till goes quiet',
                blurb:
                    'With a bill on screen and nothing rung up for this long, '
                    'the adverts take the whole screen. The bill comes straight '
                    'back the moment anything is added to it.',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _Slider(
                      label: 'Go full screen after',
                      value: _idle.toDouble(),
                      min: 0,
                      max: 300,
                      suffix: _idle == 0
                          ? 'never — keep the bill up'
                          : '$_idle seconds',
                      onChanged: (v) => setState(() => _idle = v.round()),
                    ),
                    const _Note(
                      'A till with nothing rung up on it always shows adverts '
                      'full screen, whatever this is set to.',
                    ),
                  ],
                ),
              ),

              if (!_tillOwnsSettings)
                _Section(
                  title: 'What the customer reads',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Show a price against each line'),
                      subtitle: const Text(
                        'The total is always shown. Turn this off where prices '
                        'are agreed at the counter.',
                      ),
                      value: _prices,
                      onChanged: (v) => setState(() => _prices = v),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _thanks,
                      decoration: const InputDecoration(
                        labelText: 'Message after a sale is paid for',
                      ),
                    ),
                  ],
                ),
              ),

              // The way out, and on a screen with no title bar it is the
              // only one. The till puts its exit in the same place and asks
              // the same question first, for the same reason: this is one tap
              // from a dark screen facing the public.
              _Section(
                title: 'Close the display',
                blurb:
                    'This window has no title bar and no close button, so this '
                    'is the way out. The till carries on selling either way — '
                    'the only thing that stops is the picture facing the '
                    'customer.',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_fullScreen)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(
                          Icons.fullscreen_exit,
                          color: Brand.inkSoft,
                        ),
                        title: const Text('Leave full screen'),
                        subtitle: const Text(
                          'Puts the window back with its bar, without changing '
                          'the setting. Escape does the same thing from the '
                          'display itself.',
                          style: TextStyle(fontSize: 12.5),
                        ),
                        onTap: () =>
                            unawaited(leaveFullScreen()),
                      ),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(
                        Icons.power_settings_new,
                        color: Color(0xFFE0575B),
                      ),
                      title: const Text('Exit Vesopa Customer Display'),
                      subtitle: const Text(
                        'Shuts this screen down completely. Nothing is lost — '
                        'it picks the till back up when it is started again.',
                        style: TextStyle(fontSize: 12.5),
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: _confirmExit,
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }
}

/// The list of monitors, and what full screen does to the chosen one.
///
/// A list of radio buttons rather than a dropdown. There are two of these in
/// almost every venue and never more than a handful, and a list shows both at
/// once with their sizes beside them — which is how somebody tells a 1920x1080
/// counter screen from the 1280x1024 one on the wall without unplugging either.
class _ScreenChooser extends StatelessWidget {
  const _ScreenChooser({
    required this.screens,
    required this.read,
    required this.chosen,
    required this.fullScreen,
    required this.onChosen,
    required this.onFullScreen,
  });

  final List<Screen> screens;

  /// Whether the enquiry has come back. Distinguishes "still looking" from
  /// "looked, and there is nothing", which are the same empty list.
  final bool read;

  final String chosen;
  final bool fullScreen;
  final ValueChanged<String> onChosen;
  final ValueChanged<bool> onFullScreen;

  @override
  Widget build(BuildContext context) {
    if (!read) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: LinearProgressIndicator(),
      );
    }
    if (screens.isEmpty) {
      return const _Note(
        'Windows did not report any screens, so this window cannot be moved '
        "for you. Drag it onto the customer's monitor and maximise it.",
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final screen in screens)
          ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            leading: Icon(
              screen.matches(chosen)
                  ? Icons.radio_button_checked
                  : Icons.radio_button_unchecked,
              color: screen.matches(chosen) ? Brand.lime : Brand.inkSoft,
            ),
            title: Text(
              screen.label,
              style: const TextStyle(color: Brand.ink, fontSize: 14),
            ),
            onTap: () => onChosen(screen.key),
          ),

        // Offered whether or not a screen has been chosen, because the two
        // are separate questions. A single-screen machine has no screen worth
        // choosing and still wants full screen — and gating the fill on the
        // choice is exactly the bug that made this toggle do nothing there.
        const SizedBox(height: 4),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Full screen'),
          subtitle: Text(
            chosen.isEmpty
                ? 'Fills the screen this window is already on, with no title '
                      'bar and nothing to drag. Press Escape to get the window '
                      'back.'
                : 'Fills the chosen screen, with no title bar and nothing to '
                      'drag. Press Escape to get the window back.',
          ),
          value: fullScreen,
          onChanged: onFullScreen,
        ),

        if (chosen.isEmpty)
          const _Note(
            'No screen chosen, so this window fills whichever one it is '
            "already on. On a two-screen till that is the till's own screen "
            'until you pick the other one above.',
          ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child, this.blurb});

  final String title;
  final String? blurb;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 22),
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Brand.panelSoft,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: Brand.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w700,
            color: Brand.ink,
          ),
        ),
        if (blurb != null) ...[
          const SizedBox(height: 6),
          Text(
            blurb!,
            style: const TextStyle(fontSize: 13, color: Brand.inkSoft),
          ),
        ],
        const SizedBox(height: 16),
        child,
      ],
    ),
  );
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: const TextStyle(fontSize: 12.5, color: Brand.inkSoft, height: 1.4),
  );
}

class _Slider extends StatelessWidget {
  const _Slider({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.suffix,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final String suffix;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Brand.ink)),
          Text(suffix, style: const TextStyle(color: Brand.lime)),
        ],
      ),
      Slider(
        value: value.clamp(min, max),
        min: min,
        max: max,
        // Five-second steps: nobody sets a customer display to 47 seconds, and
        // a continuous slider makes landing on 45 fiddly.
        divisions: ((max - min) / 5).round(),
        onChanged: onChanged,
      ),
    ],
  );
}
