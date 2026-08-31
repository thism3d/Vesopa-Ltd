/// Setting the screen up.
///
/// Reached from a deliberately faint cog in the corner of the display. This is
/// the only screen in the application anybody types into, and it is used once,
/// on the day the display is mounted — so it says what each setting does rather
/// than assuming somebody will find out.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/adverts.dart';
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
    _adverts.text = settings.advertFolder;
    _thanks.text = settings.thankYou;
    _idle = settings.idleSeconds;
    _dwell = settings.dwellSeconds;
    _prices = settings.showPrices;
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
        thankYou: _thanks.text.trim().isEmpty ? 'Thank you' : _thanks.text.trim(),
      ),
    );
    if (mounted) Navigator.of(context).pop();
  }

  /// Whether the till's file is actually there, said now rather than found out
  /// later by a customer looking at a blank screen.
  String _basketState() {
    final path = _basket.text.trim();
    if (path.isEmpty) return 'Not set.';
    final file = File(path);
    if (!file.existsSync()) {
      return 'Nothing at that path yet. The till writes it when it opens a '
          'bill, so this is normal before the till has been started.';
    }
    final age = DateTime.now().difference(file.lastModifiedSync());
    if (age.inMinutes < 2) return 'Found, and the till is writing to it.';
    return 'Found, last written ${_ago(age)} ago.';
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
                    'The file the till writes the current bill to. On a display '
                    'running on the same PC as the till this is already right '
                    'and should not need changing.',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextField(
                      controller: _basket,
                      onChanged: (_) => setState(() {}),
                      style: const TextStyle(fontFamily: 'Consolas'),
                      decoration: InputDecoration(
                        labelText: 'Basket file',
                        hintText: defaultBasketPath() ?? '',
                        suffixIcon: IconButton(
                          icon: const Icon(Icons.restore),
                          tooltip: 'Use the standard path',
                          onPressed: () => setState(
                            () => _basket.text = defaultBasketPath() ?? '',
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    _Note(_basketState()),
                  ],
                ),
              ),

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

              const SizedBox(height: 24),
              Center(
                child: TextButton.icon(
                  icon: const Icon(Icons.close_fullscreen),
                  label: const Text('Close the display'),
                  onPressed: () => SystemNavigator.pop(),
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
