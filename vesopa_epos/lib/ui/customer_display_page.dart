/// The customer display, set up from the till.
///
/// The manager is standing at the till. The display is a screen facing the
/// other way, mounted on a bracket, with no keyboard in front of it — so every
/// setting it has is here, and the display's own settings screen is the
/// fallback for the rare case where the two are on different machines.
///
/// See `data/customer_display_control.dart` for the two files this page reads
/// and writes, and why they are files.
///
/// WHAT THIS PAGE CANNOT DO BY ITSELF
///
/// It cannot list the monitors. Those belong to the display's machine, which on
/// a two-machine setup is not this one, and even on one machine they belong to
/// the other process's view of the desktop. So the display reports them in its
/// status file and this page offers back what it was told — which is also why
/// the screen picker says so plainly when no display has ever reported in.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/customer_display_control.dart';
import 'theme.dart';

class CustomerDisplayPage extends ConsumerStatefulWidget {
  const CustomerDisplayPage({super.key});

  @override
  ConsumerState<CustomerDisplayPage> createState() =>
      _CustomerDisplayPageState();
}

class _CustomerDisplayPageState extends ConsumerState<CustomerDisplayPage> {
  final _adverts = TextEditingController();
  final _thanks = TextEditingController();
  final _standing = TextEditingController();

  DisplayControl _control = const DisplayControl();
  DisplayStatus? _status;
  bool _loaded = false;

  /// Whether the last write failed. A settings screen that appears to have
  /// saved and has not is worse than one that says it could not.
  bool _writeFailed = false;

  /// Polls the display's status file.
  ///
  /// Two seconds, because this page is looked at while somebody is plugging a
  /// screen in and switching the display on, and it should catch up with them
  /// rather than the other way round.
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _poll = Timer.periodic(
      const Duration(seconds: 2),
      (_) => unawaited(_refreshStatus()),
    );
  }

  @override
  void dispose() {
    _poll?.cancel();
    _adverts.dispose();
    _thanks.dispose();
    _standing.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final control = await readDisplayControl();
    final status = await readDisplayStatus();
    if (!mounted) return;
    setState(() {
      _control = control;
      _status = status;
      _adverts.text = control.advertFolder;
      _thanks.text = control.thankYou;
      _standing.text = control.standingMessage;
      _loaded = true;
    });
  }

  Future<void> _refreshStatus() async {
    final status = await readDisplayStatus();
    if (!mounted) return;
    setState(() => _status = status);
  }

  /// Save on every change, rather than behind a button.
  ///
  /// The display applies within a second or two, so the manager can look up at
  /// the screen and see what they just did. A Save button would mean setting
  /// four things blind and then finding out.
  Future<void> _push(DisplayControl next) async {
    setState(() => _control = next);
    final written = await writeDisplayControl(next);
    if (!mounted) return;
    setState(() => _writeFailed = !written);
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) {
      return const Center(child: CircularProgressIndicator());
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _StatusCard(status: _status),

        if (_writeFailed) ...[
          const SizedBox(height: 12),
          Card(
            margin: EdgeInsets.zero,
            color: Pos.red.withValues(alpha: 0.08),
            child: const ListTile(
              leading: Icon(Icons.error_outline, color: Pos.red),
              title: Text('These settings could not be saved'),
              subtitle: Text(
                "The till could not write to its own data folder, so the "
                "display is still running on what it had. Nothing else about "
                "the till is affected.",
                style: TextStyle(fontSize: 12.5),
              ),
            ),
          ),
        ],

        const SizedBox(height: 28),
        const _SectionTitle('Which screen'),
        Card(
          margin: EdgeInsets.zero,
          child: _ScreenPicker(
            status: _status,
            chosen: _control.screenKey,
            fullScreen: _control.fullScreen,
            onChosen: (key) => _push(_control.copyWith(screenKey: key)),
            onFullScreen: (on) => _push(_control.copyWith(fullScreen: on)),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('Adverts'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'A folder on the machine the display is running on. Drop '
                  'pictures or clips into it and they appear on the screen — '
                  'nothing needs restarting. PNG, JPG, GIF, WEBP, MP4 and MOV '
                  'are played, in file-name order, so name them 01, 02, 03 to '
                  'set the order.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _adverts,
                  decoration: const InputDecoration(
                    labelText: 'Advert folder',
                    hintText: r'D:\Vesopa\Adverts',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (value) =>
                      _push(_control.copyWith(advertFolder: value.trim())),
                ),
                const SizedBox(height: 6),
                Text(
                  _status == null
                      ? 'No display has reported in yet, so there is nothing to '
                            'count here.'
                      : _status!.advertCount == 0
                      ? 'The display is finding no adverts in that folder. It '
                            'shows the Vesopa card instead.'
                      : 'The display is playing ${_status!.advertCount} '
                            'advert${_status!.advertCount == 1 ? '' : 's'} from '
                            'that folder.',
                  style: const TextStyle(fontSize: 12.5, color: Pos.graphite),
                ),
                const SizedBox(height: 20),
                _Slider(
                  label: 'Each picture stays up for',
                  value: _control.dwellSeconds.toDouble(),
                  min: 3,
                  max: 60,
                  suffix: '${_control.dwellSeconds} seconds',
                  onChanged: (v) =>
                      _push(_control.copyWith(dwellSeconds: v.round())),
                ),
                const Text(
                  'A clip always plays to its end, whatever this says.',
                  style: TextStyle(fontSize: 12.5, color: Pos.graphite),
                ),
                const SizedBox(height: 20),
                _Slider(
                  label: 'Sound on video adverts',
                  value: _control.advertVolume.toDouble(),
                  min: 0,
                  max: 100,
                  step: 10,
                  suffix: _control.advertVolume == 0
                      ? 'silent'
                      : '${_control.advertVolume}%',
                  onChanged: (v) =>
                      _push(_control.copyWith(advertVolume: v.round())),
                ),
                const Text(
                  'Silent unless you turn it up. A screen on the counter '
                  'playing a soundtrack at somebody waiting to be served is '
                  'usually a complaint.',
                  style: TextStyle(fontSize: 12.5, color: Pos.graphite),
                ),
                const SizedBox(height: 8),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Fill the panel'),
                  subtitle: const Text(
                    'Crops the advert to fill the space instead of fitting it '
                    'inside with black bars. Leave this off if your adverts '
                    'have writing near the edges — it gets cropped away.',
                    style: TextStyle(fontSize: 12.5),
                  ),
                  value: _control.fillScreen,
                  onChanged: (on) => _push(_control.copyWith(fillScreen: on)),
                ),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('When the till goes quiet'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'With a bill on screen and nothing rung up for this long, the '
                  'adverts take the whole screen. The bill comes straight back '
                  'the moment anything is added to it.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 14),
                _Slider(
                  label: 'Go full screen after',
                  value: _control.idleSeconds.toDouble(),
                  min: 0,
                  max: 300,
                  suffix: _control.idleSeconds == 0
                      ? 'never — keep the bill up'
                      : '${_control.idleSeconds} seconds',
                  onChanged: (v) =>
                      _push(_control.copyWith(idleSeconds: v.round())),
                ),
                const Text(
                  'A till with nothing rung up on it always shows adverts full '
                  'screen, whatever this is set to.',
                  style: TextStyle(fontSize: 12.5, color: Pos.graphite),
                ),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('How the screen is laid out'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'While a sale is being rung up the screen is split: the bill '
                  'on one side, the adverts on the other. Which side and how '
                  'much depends on your counter, so both are yours to set.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 14),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Put the bill on the right'),
                  subtitle: const Text(
                    'Set this to match where the customer stands, so the bill '
                    'is the half nearest them.',
                    style: TextStyle(fontSize: 12.5),
                  ),
                  value: _control.billOnRight,
                  onChanged: (on) => _push(_control.copyWith(billOnRight: on)),
                ),
                const SizedBox(height: 8),
                _Slider(
                  label: 'The bill takes',
                  value: _control.billShare.toDouble(),
                  min: 20,
                  max: 80,
                  step: 5,
                  suffix: '${_control.billShare}% of the screen',
                  onChanged: (v) =>
                      _push(_control.copyWith(billShare: v.round())),
                ),
                const Text(
                  'A venue whose adverts are upright posters wants a narrow '
                  'bill. One ringing up long rounds wants a wide one.',
                  style: TextStyle(fontSize: 12.5, color: Pos.graphite),
                ),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('What the customer reads'),
        Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              SwitchListTile(
                title: const Text('Show a price against each line'),
                subtitle: const Text(
                  'The total is always shown. Turn this off where prices are '
                  'agreed at the counter.',
                  style: TextStyle(fontSize: 12.5),
                ),
                value: _control.showPrices,
                onChanged: (on) => _push(_control.copyWith(showPrices: on)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: TextField(
                  controller: _standing,
                  decoration: const InputDecoration(
                    labelText: 'A line across the bottom of the adverts',
                    hintText: 'Ask about our loyalty card',
                    helperText: 'Leave it empty for nothing at all.',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (value) =>
                      _push(_control.copyWith(standingMessage: value.trim())),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                child: TextField(
                  controller: _thanks,
                  decoration: const InputDecoration(
                    labelText: 'Message after a sale is paid for',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (value) => _push(
                    _control.copyWith(
                      thankYou: value.trim().isEmpty ? 'Thank you' : value.trim(),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 32),
      ],
    );
  }
}

/// Whether a display is out there, and what it is doing.
///
/// First on the page on purpose. Every other control here is pointless if
/// nothing is listening, and "I changed it and nothing happened" is the support
/// call this card exists to prevent.
class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.status});

  final DisplayStatus? status;

  @override
  Widget build(BuildContext context) {
    final live = status?.isLive ?? false;

    return Card(
      margin: EdgeInsets.zero,
      color: live ? Pos.brandSoft : null,
      child: ListTile(
        leading: Icon(
          live ? Icons.desktop_windows : Icons.desktop_access_disabled,
          color: live ? Pos.brandDeep : Pos.graphite,
        ),
        title: Text(
          live ? 'Customer display connected' : 'No customer display running',
        ),
        subtitle: Text(
          live
              ? [
                  if (status!.appVersion.isNotEmpty)
                    'Version ${status!.appVersion}',
                  status!.fullScreen ? 'full screen' : 'in a window',
                  '${status!.screens.length} screen'
                      '${status!.screens.length == 1 ? '' : 's'} attached',
                ].join('  ·  ')
              : status == null
              ? 'Install Vesopa Customer Display on this PC and start it. It '
                    'finds this till on its own — there is nothing to type in. '
                    'Anything set here is waiting for it when it starts.'
              : 'It was running, but has not reported in for a while. It has '
                    'been closed, or the PC it is on is off.',
          style: const TextStyle(fontSize: 12.5),
        ),
      ),
    );
  }
}

/// The monitor picker, built from what the display reported.
class _ScreenPicker extends StatelessWidget {
  const _ScreenPicker({
    required this.status,
    required this.chosen,
    required this.fullScreen,
    required this.onChosen,
    required this.onFullScreen,
  });

  final DisplayStatus? status;
  final String chosen;
  final bool fullScreen;
  final ValueChanged<String> onChosen;
  final ValueChanged<bool> onFullScreen;

  @override
  Widget build(BuildContext context) {
    final screens = status?.screens ?? const <DisplayScreenOption>[];

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'The till and the customer display are two windows on one PC with '
            'two screens. This is the one the customer can see — choosing it '
            'moves the display there straight away, so you can look up and '
            'check you picked the right one.',
            style: TextStyle(fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 12),

          if (screens.isEmpty)
            const Text(
              'No display has reported its screens yet. Start Vesopa Customer '
              'Display on this PC and they will appear here within a few '
              'seconds.',
              style: TextStyle(fontSize: 12.5, color: Pos.graphite),
            )
          else ...[
            for (final screen in screens)
              ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                leading: Icon(
                  screen.key == chosen
                      ? Icons.radio_button_checked
                      : Icons.radio_button_unchecked,
                  color: screen.key == chosen ? Pos.brandDeep : Pos.graphite,
                ),
                title: Text(screen.label),
                onTap: () => onChosen(screen.key),
              ),
            if (chosen.isNotEmpty)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  icon: const Icon(Icons.clear, size: 18),
                  label: const Text('Let it open wherever Windows puts it'),
                  onPressed: () => onChosen(''),
                ),
              ),
          ],

          const Divider(height: 24),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Full screen'),
            subtitle: const Text(
              'No title bar and nothing to drag, which is what a customer '
              'should be looking at. Pressing Escape on the display gets the '
              'window back if it is ever needed.',
              style: TextStyle(fontSize: 12.5),
            ),
            value: fullScreen,
            onChanged: onFullScreen,
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.1,
        color: Pos.graphite,
      ),
    ),
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
    this.step = 5,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final String suffix;
  final ValueChanged<double> onChanged;

  /// How far one notch moves it. Nobody sets a customer display to 47 seconds
  /// or a bill to 43% of the screen, and a continuous slider makes landing on
  /// a round number fiddly on a touch screen.
  final double step;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 13)),
          Text(
            suffix,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: Pos.brandDeep,
            ),
          ),
        ],
      ),
      Slider(
        value: value.clamp(min, max),
        min: min,
        max: max,
        divisions: ((max - min) / step).round(),
        onChanged: onChanged,
      ),
    ],
  );
}
