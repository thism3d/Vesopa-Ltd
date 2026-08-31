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
import 'package:video_player/video_player.dart';

import '../data/adverts.dart';
import 'theme.dart';

class AdvertPanel extends StatefulWidget {
  const AdvertPanel({
    super.key,
    required this.adverts,
    required this.rotation,
    required this.dwell,
  });

  final List<Advert> adverts;

  /// Owned by the page above, so going full screen and coming back does not
  /// restart the loop.
  final AdvertRotation rotation;

  final Duration dwell;

  @override
  State<AdvertPanel> createState() => _AdvertPanelState();
}

class _AdvertPanelState extends State<AdvertPanel> {
  Timer? _timer;
  VideoPlayerController? _video;

  /// Which advert the current [_video] belongs to, so a rebuild for an
  /// unrelated reason does not tear down a clip half way through.
  String? _videoPath;

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
      widget.rotation.reset();
      _schedule();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    unawaited(_video?.dispose());
    super.dispose();
  }

  Advert? get _current => widget.rotation.current(widget.adverts);

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
    setState(() => widget.rotation.advance(widget.adverts));
    _schedule();
  }

  void _disposeVideo() {
    final video = _video;
    _video = null;
    _videoPath = null;
    unawaited(video?.dispose());
  }

  Future<void> _playVideo(Advert advert) async {
    if (_videoPath == advert.path) return;
    _disposeVideo();

    final controller = VideoPlayerController.file(File(advert.path));
    _videoPath = advert.path;
    _video = controller;

    try {
      await controller.initialize();
      if (!mounted || _video != controller) return;

      // Muted, always. A customer display is beside a till in a room with
      // people in it, and an advert that starts talking is one a venue turns
      // the screen off rather than the sound down.
      await controller.setVolume(0);
      await controller.play();
      setState(() {});

      controller.addListener(() {
        if (!mounted || _video != controller) return;
        final value = controller.value;
        if (value.isInitialized &&
            !value.isPlaying &&
            value.position >= value.duration) {
          _next();
        }
      });
    } catch (_) {
      // A codec Windows does not have, or a file still being copied in. Move
      // on rather than leaving a black rectangle where the advert should be.
      if (mounted) _next();
    }
  }

  @override
  Widget build(BuildContext context) {
    final advert = _current;
    if (advert == null) return const _NoAdverts();

    if (advert.kind == AdvertKind.video) {
      final video = _video;
      if (video == null || !video.value.isInitialized) {
        return const ColoredBox(color: Colors.black);
      }
      return ColoredBox(
        color: Colors.black,
        child: Center(
          child: AspectRatio(
            aspectRatio: video.value.aspectRatio,
            child: VideoPlayer(video),
          ),
        ),
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
        fit: BoxFit.contain,
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
