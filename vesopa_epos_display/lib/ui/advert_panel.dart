/// The adverts, drawn.
///
/// One widget for both jobs — the half beside the bill and the whole screen
/// when the till has gone quiet — because they are the same loop at two sizes.
/// Making them two widgets is how the full-screen one ends up restarting at the
/// first poster every time somebody puts a pint on the bill.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../data/adverts.dart';
import 'theme.dart';

class AdvertPanel extends StatefulWidget {
  const AdvertPanel({
    super.key,
    required this.adverts,
    required this.rotation,
    required this.dwell,
    this.volume = 0,
    this.fillPanel = false,
    this.standingMessage = '',
  });

  final List<Advert> adverts;

  /// Owned by the page above, so going full screen and coming back does not
  /// restart the loop.
  final AdvertRotation rotation;

  final Duration dwell;

  /// How loud clips play, 0 to 100. Silent by default — see [_playVideo].
  final int volume;

  /// Whether adverts fill the panel, cropping to fit, rather than sitting
  /// inside it with black bars.
  ///
  /// Off by default. An advert is a designed thing with words on it, and
  /// cropping the phone number off the bottom to fill an awkward panel is
  /// worse than a letterbox.
  final bool fillPanel;

  /// A line the venue sets, drawn across the bottom of the adverts.
  ///
  /// For the thing staff would otherwise have to say to everybody — "Ask about
  /// our loyalty card", "Kitchen closes at nine". Empty draws nothing at all
  /// rather than an empty strip, because a band of dead space across the
  /// bottom of every advert is worse than no band.
  final String standingMessage;

  @override
  State<AdvertPanel> createState() => _AdvertPanelState();
}

class _AdvertPanelState extends State<AdvertPanel> {
  Timer? _timer;

  /// The clip player, and its texture.
  ///
  /// media_kit rather than video_player, and that choice was made the hard way.
  /// video_player on Windows goes through Media Foundation, which is **not
  /// present on every machine a till runs on** — it is absent on Windows Server
  /// and on the N editions of Windows, and it needs a GPU it can talk to. On a
  /// machine without it the open failed and took the whole process down with
  /// it, which on a customer display means a black screen nobody is watching
  /// for faults.
  ///
  /// media_kit carries its own decoder. It is tens of megabytes in the package
  /// and worth every one of them: a venue's promo is whatever their agency
  /// exported, on whatever PC is under the counter, and it has to play.
  Player? _player;
  VideoController? _texture;
  StreamSubscription<bool>? _completed;

  /// How long a clip gets to start before it is judged unplayable.
  ///
  /// Generous. A large file off a slow disk on a machine decoding in software
  /// can take a few seconds to show its first frame, and striking such a clip
  /// off would be worse than the black rectangle it is meant to prevent.
  static const _startingUp = Duration(seconds: 12);
  Timer? _watchdog;

  /// Which advert the current [_video] belongs to, so a rebuild for an
  /// unrelated reason does not tear down a clip half way through.
  String? _videoPath;

  /// Clips this machine could not open, by path.
  ///
  /// **This is what stops a bad clip taking the display down.** A video that
  /// fails to open used to call [_next], and in a folder holding one video that
  /// wraps straight back to the same file — a native open, a failure and
  /// another open, as fast as the loop can turn, until the process died. It is
  /// not a hypothetical: a machine without Media Foundation (Windows Server, a
  /// VM with no GPU) fails every open, and the screen facing the customer went
  /// black.
  ///
  /// So a clip that fails is remembered and skipped, and if every advert in the
  /// folder fails the panel falls back to the Vesopa card — which is what an
  /// empty folder shows, and is at least a thing somebody can look at.
  final _broken = <String>{};

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(AdvertPanel old) {
    super.didUpdateWidget(old);
    // The folder changed under us — a manager dropped a poster in. Start the
    // loop again so the new file is reached rather than waiting for the
    // rotation to come round to a position that may no longer exist.
    if (old.adverts.length != widget.adverts.length) {
      // A clean slate on the broken list too. The manager may have just
      // replaced the clip that would not play with one that will, and a
      // display that remembered the old verdict for ever would never find out.
      _broken.clear();
      widget.rotation.reset();
      _schedule();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _disposeVideo();
    super.dispose();
  }

  /// The adverts that can actually be shown.
  ///
  /// Everything the rotation is driven from, so a broken clip is not merely
  /// skipped when it comes round — it is not in the loop at all.
  List<Advert> get _playable => _broken.isEmpty
      ? widget.adverts
      : [
          for (final advert in widget.adverts)
            if (!_broken.contains(advert.path)) advert,
        ];

  Advert? get _current => widget.rotation.current(_playable);

  /// Set up whatever the current advert needs, and decide when to move on.
  void _schedule() {
    _timer?.cancel();

    final advert = _current;
    if (advert == null) {
      _disposeVideo();
      return;
    }

    if (advert.kind == AdvertKind.video) {
      _playVideo(advert);
      // No timer: a clip advances when it ends. A fixed dwell over a video
      // either cuts it off or leaves a frozen last frame up, and both look
      // like a fault.
      return;
    }

    _disposeVideo();
    _timer = Timer(widget.dwell, _next);
  }

  void _next() {
    if (!mounted) return;
    setState(() => widget.rotation.advance(_playable));
    _schedule();
  }

  void _disposeVideo() {
    final player = _player;
    _player = null;
    _texture = null;
    _videoPath = null;
    unawaited(_completed?.cancel());
    _completed = null;
    _watchdog?.cancel();
    _watchdog = null;
    unawaited(player?.dispose());
  }

  Future<void> _playVideo(Advert advert) async {
    if (_videoPath == advert.path) return;
    _disposeVideo();

    final player = Player();
    final texture = VideoController(player);
    _videoPath = advert.path;
    _player = player;
    _texture = texture;

    try {
      // Silent unless the venue has asked for sound. A screen on a counter
      // playing a soundtrack at the person waiting to be served is a
      // complaint, not a feature.
      await player.setVolume(widget.volume.clamp(0, 100).toDouble());

      // The clip plays once. Looping is the rotation's job, and a single clip
      // set to loop would never hand the screen back to the next advert.
      await player.setPlaylistMode(PlaylistMode.none);

      _completed = player.stream.completed.listen((done) {
        if (done && mounted && _player == player) _next();
      });

      await player.open(Media(advert.path));
      if (!mounted || _player != player) return;
      setState(() {});

      // A watchdog, rather than the player's error stream.
      //
      // The error stream carries warnings as well as failures — mpv reports
      // things like a missing hardware decoder on it and then plays the clip
      // perfectly well in software — so treating any message on it as fatal
      // struck good adverts off the list. What actually distinguishes a clip
      // this machine cannot play is that it never plays: no position, ever.
      _watchdog = Timer(_startingUp, () {
        if (!mounted || _player != player) return;
        if (player.state.position > Duration.zero || player.state.playing) {
          return;
        }
        _giveUpOn(advert);
      });
    } catch (_) {
      _giveUpOn(advert);
    }
  }

  /// Strike a clip off and move on.
  ///
  /// See [_broken]. The one rule is that this must never lead back to the same
  /// clip, which is what turned a machine with no decoder into a dead display.
  void _giveUpOn(Advert advert) {
    if (_broken.contains(advert.path)) return;
    _broken.add(advert.path);
    _disposeVideo();
    if (mounted) _next();
  }

  @override
  Widget build(BuildContext context) => widget.standingMessage.trim().isEmpty
      ? _advert(context)
      : Stack(
          fit: StackFit.expand,
          children: [
            _advert(context),
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: _StandingMessage(widget.standingMessage.trim()),
            ),
          ],
        );

  Widget _advert(BuildContext context) {
    final advert = _current;
    if (advert == null) return const _NoAdverts();

    if (advert.kind == AdvertKind.video) {
      final texture = _texture;
      if (texture == null) return const ColoredBox(color: Colors.black);
      return Video(
        controller: texture,
        // The panel's own black, and no controls: nobody is going to scrub a
        // customer display, and a play button drawn over an advert is a play
        // button a customer will press.
        fill: Colors.black,
        controls: NoVideoControls,
        fit: widget.fillPanel ? BoxFit.cover : BoxFit.contain,
      );
    }

    return ColoredBox(
      color: Colors.black,
      child: Image.file(
        File(advert.path),
        key: ValueKey(advert.path),
        // Contain, not cover. An advert is a designed thing with words on it,
        // and cropping the words off to fill an awkward panel is worse than a
        // black band down each side.
        fit: widget.fillPanel ? BoxFit.cover : BoxFit.contain,
        width: double.infinity,
        height: double.infinity,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) {
          // A file that is not really an image. Skip it on the next frame
          // rather than during a build.
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) _next();
          });
          return const ColoredBox(color: Colors.black);
        },
      ),
    );
  }
}

/// What a screen shows before anybody has given it any adverts.
///
/// Deliberately not a black rectangle. A display that has been switched on,
/// mounted and pointed at a customer with nothing set up looks broken, and the
/// person who can fix it is standing on the other side of the counter.
class _NoAdverts extends StatelessWidget {
  const _NoAdverts();

  @override
  Widget build(BuildContext context) => ColoredBox(
    color: Brand.panelSoft,
    child: Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(
              'assets/brand/vesopa_logo_on_dark.png',
              width: 220,
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
            ),
            const SizedBox(height: 24),
            const Text(
              'No adverts yet',
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w700,
                color: Brand.ink,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Choose a folder of pictures or clips in Settings, and they will '
              'play here.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14, color: Brand.inkSoft),
            ),
          ],
        ),
      ),
    ),
  );
}

/// The venue's own line, across the bottom of the adverts.
///
/// Drawn over the advert rather than beside it, on a gradient rather than a
/// solid bar: an advert is a designed thing, and taking a strip off the bottom
/// of it to hold a sentence spoils the design in a way a fade does not.
class _StandingMessage extends StatelessWidget {
  const _StandingMessage(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(28, 40, 28, 20),
    decoration: const BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Colors.transparent, Color(0xCC000000)],
      ),
    ),
    child: Text(
      text,
      textAlign: TextAlign.center,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(
        // Large. Read across a counter by somebody not wearing their glasses,
        // the same rule the bill is set by.
        fontSize: 26,
        fontWeight: FontWeight.w600,
        color: Brand.ink,
        height: 1.25,
      ),
    ),
  );
}
