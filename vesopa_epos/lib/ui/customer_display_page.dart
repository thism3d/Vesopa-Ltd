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

import '../config/constants.dart';
import '../data/customer_display_control.dart';
import '../data/deep_links.dart';
import '../data/device_registry.dart';
import '../data/display_pairing.dart';
import '../data/session_controller.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
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
  final _qr = TextEditingController();
  final _qrCaption = TextEditingController();

  DisplayControl _control = const DisplayControl();
  DisplayStatus? _status;
  bool _loaded = false;

  /// Screens on this PC asking to be connected, and screens already connected.
  ///
  /// Both re-read on the same two-second poll as the status file, because this
  /// page is open while somebody is plugging a display in and switching it on:
  /// it should catch up with them rather than the other way round.
  List<DisplayPairRequest> _pending = const [];
  List<PairedDisplay> _paired = const [];

  /// Screens that have been told "not now". Still listed, and marked, because
  /// the prompt being off is worth seeing.
  Set<String> _declined = const {};

  /// Set while a Connect is in flight, so the button cannot be pressed twice
  /// and produce two grants for one screen.
  String? _connecting;

  /// Set when Windows refused to open the Store. Worth showing: on a managed
  /// till with the Store removed the button does nothing, and one that appears
  /// broken is worse than one that explains itself.
  bool _storeRefused = false;

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
    _qr.dispose();
    _qrCaption.dispose();
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
      _qr.text = control.customerQr;
      _qrCaption.text = control.customerQrCaption;
      _loaded = true;
    });
  }

  Future<void> _refreshStatus() async {
    final pairing = ref.read(displayPairingProvider);
    final status = await readDisplayStatus();
    // Declined screens included, deliberately. Saying "not now" to the
    // full-screen prompt stops it interrupting; it does not mean the screen can
    // never be connected, and this page is where somebody comes when they have
    // decided they do want it after all.
    final pending = await pairing.pending(includeDeclined: true);
    final paired = await pairing.paired();
    final declined = await pairing.declined();
    if (!mounted) return;
    setState(() {
      _status = status;
      _pending = pending;
      _paired = paired;
      _declined = declined;
    });
  }

  /// Connect the screen the manager just pressed the button beside.
  ///
  /// The grant is written first and the back office told second, and that order
  /// matters: the display has to start working whether or not this till can
  /// reach the internet. A venue whose broadband is down still gets a customer
  /// display; what it does not get, until the next start, is a row in the back
  /// office saying so.
  Future<void> _connect(DisplayPairRequest request) async {
    final session = ref.read(sessionControllerProvider).value;
    final terminalName = ref.read(terminalNameProvider);
    final pairing = ref.read(displayPairingProvider);

    setState(() => _connecting = request.deviceId);
    final failure = await pairing.connect(
      request,
      office: session?.office ?? '',
      terminalName: terminalName,
      venueName: session?.venueName ?? '',
    );
    if (!mounted) return;
    setState(() => _connecting = null);

    if (failure != null) {
      _say(_explain(failure));
      return;
    }

    await _refreshStatus();
    unawaited(_registerWithBackOffice());
    if (mounted) _say('${request.name} is connected.');
  }

  Future<void> _forget(PairedDisplay display) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Disconnect ${display.name}?'),
        content: const Text(
          'The screen will stop showing bills and go back to asking to be '
          'connected. Nothing else about the till changes, and you can connect '
          'it again from this page.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Disconnect'),
          ),
        ],
      ),
    );
    if (!(yes ?? false)) return;

    await ref.read(displayPairingProvider).forget(display.deviceId);
    unawaited(
      ref.read(deviceRegistryProvider).offline(
        display.deviceId,
        event: 'unpaired',
      ),
    );
    await _refreshStatus();
  }

  /// Tell the back office what this venue has, now that it has changed.
  Future<void> _registerWithBackOffice() async {
    final session = ref.read(sessionControllerProvider).value;
    if (session == null || !session.signedIn) return;

    final registry = ref.read(deviceRegistryProvider);
    if (!registry.canRegister) return;

    await registry.register(
      describeDevices(
        terminalDeviceId: await terminalDeviceId(),
        terminalName: ref.read(terminalNameProvider),
        appVersion: VesopaBrand.appVersion,
        signedInAs: session.email,
        displays: await ref.read(displayPairingProvider).paired(),
      ),
    );
  }

  /// What went wrong, said so a manager can act on it.
  ///
  /// Only the first of these is the till refusing; the rest are it being
  /// unable, and each one names the thing to go and do about it.
  static String _explain(PairFailure failure) => switch (failure) {
    PairFailure.notSignedIn =>
      'Sign this till in first. A customer display belongs to a venue, and '
          'until the till is signed in there is no venue to attach it to.',
    PairFailure.noSharedFolder =>
      'This machine has no shared folder for the two applications to meet in, '
          'so a display cannot be connected on it.',
    PairFailure.noBasketFolder =>
      "The till could not open its own data folder, so there is no file to "
          'point the screen at. Nothing else about the till is affected.',
    PairFailure.couldNotWrite =>
      'The till could not write the connection file. Check that this account '
          'can write to the Vesopa folder in ProgramData.',
  };

  void _say(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
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

        // Screens asking to be connected, first and unmissable.
        //
        // This is the whole setup procedure now. A display with nowhere to
        // point puts itself here within a few seconds of being switched on, and
        // the manager presses one button — no path to find, nothing to type,
        // and no way to connect the wrong thing, because the code on the button
        // is the code on the glass in front of them.
        if (_pending.isNotEmpty) ...[
          const SizedBox(height: 28),
          const _SectionTitle('Screens waiting to be connected'),
          for (final request in _pending)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _PairRequestCard(
                request: request,
                busy: _connecting == request.deviceId,
                declined: _declined.contains(request.deviceId),
                onConnect: () => unawaited(_connect(request)),
              ),
            ),
        ],

        if (_paired.isNotEmpty) ...[
          const SizedBox(height: 28),
          const _SectionTitle('Connected screens'),
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                for (final display in _paired)
                  ListTile(
                    leading: const Icon(Icons.tv_outlined),
                    title: Text(display.name),
                    subtitle: Text(
                      'Connected ${_when(display.pairedAt)}. This till tells it '
                      'where to look on every start, so it keeps working after '
                      'an update.',
                      style: const TextStyle(fontSize: 12.5),
                    ),
                    trailing: TextButton(
                      onPressed: () => unawaited(_forget(display)),
                      child: const Text('Disconnect'),
                    ),
                  ),
              ],
            ),
          ),
        ],

        if (_pending.isEmpty && _paired.isEmpty) ...[
          const SizedBox(height: 28),
          const _SectionTitle('Connecting a screen'),
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.info_outline),
                      SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'No customer display is asking to be connected',
                              style: TextStyle(fontWeight: FontWeight.w600),
                            ),
                            SizedBox(height: 6),
                            Text(
                              'Start Vesopa Customer Display on this PC. It '
                              'puts itself on this page within a few seconds, '
                              'showing a four-digit code — check that code '
                              'against the screen and press Connect. There is '
                              'no folder to find and nothing to type.',
                              style: TextStyle(fontSize: 12.5, height: 1.4),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  // The other half of the same problem. The display can send
                  // somebody to install the till; this sends them the other
                  // way, so whichever of the two applications a venue installs
                  // first can fetch the other.
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.storefront_outlined, size: 18),
                      label: const Text('Get Vesopa Customer Display'),
                      onPressed: () async {
                        final opened = await openDisplayInStore();
                        if (mounted) setState(() => _storeRefused = !opened);
                      },
                    ),
                  ),
                  if (_storeRefused) ...[
                    const SizedBox(height: 10),
                    const Text(
                      'The Microsoft Store would not open on this machine. '
                      'Search the Store for "Vesopa Customer Display", or '
                      'install it the way the rest of this venue was set up.',
                      style: TextStyle(fontSize: 12.5, height: 1.4),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],

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

        const SizedBox(height: 28),
        const _SectionTitle('A code for the customer'),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'A QR code under the total, on the screen the customer '
                  'reads. The '
                  'moment somebody is watching their round go up is the one '
                  'moment in the day when they are looking at that screen with '
                  'a phone already in their hand — which is when "join our '
                  'scheme" actually gets done, rather than on a poster by the '
                  'door.',
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _qr,
                  decoration: const InputDecoration(
                    labelText: 'What the code opens',
                    hintText: 'https://…',
                    helperText: 'A sign-up page, a wallet pass, a review link — '
                        'anything a phone can open. Leave it empty for no code '
                        'at all.',
                    helperMaxLines: 3,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (value) =>
                      _push(_control.copyWith(customerQr: value.trim())),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _qrCaption,
                  decoration: const InputDecoration(
                    labelText: 'The line under it',
                    hintText: 'Scan to join',
                    helperText: 'A code with nothing beside it is a square '
                        'nobody points a phone at.',
                    helperMaxLines: 2,
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (value) => _push(
                    _control.copyWith(customerQrCaption: value.trim()),
                  ),
                ),
              ],
            ),
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
/// How long ago, in the roundest words that are still true.
String _when(DateTime at) {
  final age = DateTime.now().difference(at);
  if (age.inMinutes < 1) return 'just now';
  if (age.inHours < 1) return '${age.inMinutes} min ago';
  if (age.inDays < 1) return '${age.inHours} h ago';
  if (age.inDays == 1) return 'yesterday';
  return '${age.inDays} days ago';
}

/// One screen asking to be connected.
///
/// The code is the largest thing on the card on purpose. It is the only piece
/// of information the manager has to *check* rather than read — everything else
/// is the till saying what it found, and this is the one line where they get to
/// say it found the right screen.
class _PairRequestCard extends StatelessWidget {
  const _PairRequestCard({
    required this.request,
    required this.busy,
    required this.declined,
    required this.onConnect,
  });

  final DisplayPairRequest request;
  final bool busy;

  /// Whether somebody has already said "not now" to this screen. Marked rather
  /// than hidden: a manager looking for a display they dismissed by accident
  /// needs to be able to see that is what happened.
  final bool declined;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              color: Pos.green.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              children: [
                const Text(
                  'CODE',
                  style: TextStyle(
                    fontSize: 10,
                    letterSpacing: 2,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  request.code,
                  style: const TextStyle(
                    fontSize: 30,
                    height: 1.1,
                    letterSpacing: 3,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  request.name,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  declined
                      ? 'This screen was dismissed, so it no longer interrupts '
                            'the till. It is still asking, and can be connected '
                            'from here.'
                      : 'Check this code is the one on the customer display '
                            'before you connect it.'
                            '${request.appVersion.isEmpty ? '' : ' Version '
                                '${request.appVersion}.'}',
                  style: const TextStyle(fontSize: 12.5, height: 1.35),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          FilledButton(
            onPressed: busy ? null : onConnect,
            child: Text(busy ? 'Connecting…' : 'Connect'),
          ),
        ],
      ),
    ),
  );
}

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
