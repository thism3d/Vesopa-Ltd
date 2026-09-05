import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/staff_session.dart';
import '../data/till_settings.dart';
import '../main.dart';
import 'staff_handover.dart';
import 'theme.dart';
import 'widgets/staff_pin_pad.dart';

/// The screen saver, and the way back in.
///
/// Three jobs, in this order of stubbornness:
///
///  1. **Never trap the till.** Everything below has a fallback — a missing
///     image falls back to the drawn brand screen, an empty staff list falls
///     back to a message that says what to do about it, and a venue with the PIN
///     switched off gets out on any touch. A locked till that cannot be unlocked
///     is a venue that cannot trade.
///  2. **Look like Vesopa.** With no image configured this draws the wordmark
///     over the lime rule, the same composition as the splash, rather than
///     showing a black rectangle that reads as a fault.
///  3. **Take a PIN quickly.** Big keys, no keyboard, and the pad appears on the
///     first touch rather than behind another tap.
class IdleScreen extends ConsumerStatefulWidget {
  const IdleScreen({super.key, required this.settings});

  final TillSettings settings;

  @override
  ConsumerState<IdleScreen> createState() => _IdleScreenState();
}

class _IdleScreenState extends ConsumerState<IdleScreen> {
  /// Whether the PIN pad is showing, as opposed to the bare picture.
  bool _asking = false;

  @override
  void initState() {
    super.initState();
    // Opened by the Sign On key rather than by a sale finishing: the operator has
    // already said what they want, so go straight to the pad.
    _asking = ref.read(staffSessionProvider).promptPin;
  }

  String _pin = '';
  String? _error;
  bool _checking = false;

  /// Touch anywhere on the picture.
  ///
  /// With the PIN switched off this is the whole interaction: the screen clears
  /// and the till is back, with whoever was on shift still on shift.
  void _onTouch() {
    if (!widget.settings.idleRequirePin) {
      ref.read(staffSessionProvider.notifier).dismissIdle();
      return;
    }
    setState(() {
      _asking = true;
      _pin = '';
      _error = null;
    });
  }

  /// A PIN is exactly this long — the back office enforces the same number.
  static const _pinLength = 4;

  void _key(String key) {
    if (_checking) return;
    setState(() {
      _error = null;
      if (key == 'CL') {
        _pin = '';
        _rejected = false;
      } else if (key == '<') {
        // Backspace still corrects rather than restarts. One wrong key is the
        // usual mistake, and fixing it beats retyping all four — so a rejected
        // PIN keeps its digits for exactly as long as the clerk is correcting
        // them.
        if (_pin.isNotEmpty) _pin = _pin.substring(0, _pin.length - 1);
        _rejected = false;
      } else {
        // A digit after a rejection starts the next attempt, there and then.
        //
        // This is what Clear used to be for, and why it had to be pressed: a
        // refused PIN is four digits long, so `_pin.length < _pinLength` was
        // false and every further tap did nothing at all. The clerk was left
        // pressing digits at a pad that ignored them until they found Clear —
        // on the one screen where somebody is already standing over them
        // waiting to be served.
        if (_rejected) {
          _pin = '';
          _rejected = false;
        }
        if (_pin.length < _pinLength) _pin += key;
      }
    });

    // Submit on the last digit. Nobody reaches for an Enter key on a four-digit
    // PIN, and the back office guarantees there is no longer one to wait for.
    if (_pin.length == _pinLength) _submit();
  }

  Future<void> _submit() async {
    if (_checking || _pin.length < _pinLength) return;
    setState(() => _checking = true);

    final repo = ref.read(staffRepositoryProvider);
    StaffData? who;
    try {
      who = await repo.byPin(_pin);
    } catch (_) {
      who = null;
    }
    if (!mounted) return;

    if (who != null) {
      // Not `signOn` directly. Where a venue runs more than one till this also
      // moves the clerk's session off whichever terminal they were on and
      // offers to bring the bill they left there — and on a venue with one
      // till it does nothing beyond what signOn always did.
      await signOnHere(context, ref, who);
      return;
    }

    // Always say so. An earlier version stayed silent on a four-digit miss, in
    // case a longer PIN was still being typed — which meant a mistyped PIN did
    // nothing at all, and the clerk had no idea whether the till had registered
    // the taps.
    //
    // The digits are kept on screen rather than wiped, so backspacing a single
    // wrong key still beats retyping all four — but the pad no longer *waits*
    // for that. Pressing any digit starts the next attempt immediately, which
    // is what somebody who simply mistyped will do, and what they were
    // previously blocked from doing until they found Clear.
    setState(() {
      _checking = false;
      _error = 'That PIN was not recognised. Type it again, or correct it.';
      // The next digit starts a new attempt. See `_key`.
      _rejected = true;
      // Counts rejections rather than flagging one, so a second wrong PIN shakes
      // again. A bool would have set true and stayed true, leaving the till
      // silent on exactly the attempt the clerk is most likely to doubt.
      _rejections++;
    });
  }

  /// How many PINs have been turned away, purely to drive the shake below.
  int _rejections = 0;

  /// Whether the PIN currently on the pad has already been refused.
  ///
  /// Separate from [_rejections], which only ever counts up to animate. This
  /// one answers a different question — "is the next digit a correction or a
  /// fresh attempt?" — and so it is cleared the moment the clerk does either.
  bool _rejected = false;

  /// Which backdrop failed to render, if one did.
  ///
  /// Held as the source's identity rather than a bare flag, so choosing a new
  /// picture gets a fresh attempt instead of inheriting the last one's failure.
  String? _failedSource;

  /// Where the background is coming from, local override beating back-office
  /// upload. Null when the venue has set no picture at all.
  _Backdrop? _resolveBackdrop() {
    final localPath = ref.watch(idleImageOverrideProvider).value;
    final url = widget.settings.idleImageUrl;

    final absolute = url == null || url.isEmpty
        ? null
        : (url.startsWith('http') ? url : '${ref.watch(apiBaseProvider)}$url');

    if (localPath != null && localPath.isNotEmpty) {
      final file = File(localPath);
      // A path that no longer resolves falls through to the venue's upload
      // rather than showing black.
      if (file.existsSync()) {
        return _Backdrop(file: file, fallbackUrl: absolute);
      }
    }
    return absolute == null ? null : _Backdrop(url: absolute);
  }

  /// Note that the chosen picture could not be shown, so the screen falls back to
  /// the drawn brand composition. Deferred a frame because this is reported from
  /// inside an errorBuilder, which runs during build.
  void _onImageFailed(String source) {
    if (_failedSource == source) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _failedSource = source);
    });
  }

  @override
  Widget build(BuildContext context) {
    final backdrop = _resolveBackdrop();

    // Whether a picture is actually on screen — which is what decides the whole
    // composition below, so it is answered once here rather than guessed twice.
    final overImage = backdrop != null && backdrop.key != _failedSource;

    return Material(
      color: Colors.black,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (backdrop != null)
            _Background(backdrop: backdrop, onFailed: _onImageFailed),

          // Scrim.
          //
          // Full-screen behind the PIN pad, because the pad has to be readable
          // over any photograph. At rest it is a bottom-weighted gradient
          // instead: the venue chose that picture to be looked at, so the top of
          // it is left alone and only the strip under the caption is darkened.
          //
          // None at all when there is no picture — the screen is already black,
          // and darkening black only dulls the lime rule.
          //
          // 35% behind the pad, down from 85%. The venue chose that picture and
          // an 85% scrim was blacking it out: on a light photograph the sign-on
          // screen read as a dark slab with a pad on it rather than as the
          // venue's own screen.
          //
          // This scrim is no longer what makes the pad readable, and it is
          // worth being clear about that: readability now comes from the pad's
          // own opaque console (see [_Keypad]), which is the only thing that
          // holds against *any* picture the venue picks. What is left here is
          // focus — a quarter-second dim that says the screen is asking for
          // something — so it can stay light without a legibility cost.
          //
          // Faded between rather than swapped. The pad's scrim arriving in one
          // frame reads as the picture being switched off; brought up over a
          // quarter-second it reads as the picture being dimmed to make room.
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 260),
            child: _asking
                ? const ColoredBox(
                    key: ValueKey('scrim'),
                    color: Color(0x59000000),
                  )
                : overImage
                ? const DecoratedBox(
                    key: ValueKey('gradient'),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.center,
                        end: Alignment.bottomCenter,
                        colors: [Color(0x00000000), Color(0xB3000000)],
                      ),
                    ),
                  )
                : const SizedBox.shrink(key: ValueKey('none')),
          ),

          // Waking the pad is the one moment on this screen the clerk is
          // waiting on, so it gets a move of its own rather than replacing the
          // picture outright: the pad rises the last few pixels into place as it
          // fades up, and drops back the same way on Cancel.
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 280),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeIn,
            transitionBuilder: (child, animation) => FadeTransition(
              opacity: animation,
              child: SlideTransition(
                position: Tween(
                  begin: const Offset(0, 0.04),
                  end: Offset.zero,
                ).animate(animation),
                child: child,
              ),
            ),
            child: _asking
                ? KeyedSubtree(key: const ValueKey('pad'), child: _pad(context))
                : KeyedSubtree(
                    key: const ValueKey('rest'),
                    child: _resting(context, overImage: overImage),
                  ),
          ),
        ],
      ),
    );
  }

  /// The screen at rest.
  ///
  /// Two compositions, because a picture and the wordmark are both the subject
  /// and cannot both be it:
  ///
  ///  * **No picture** — the drawn brand screen: wordmark over the lime rule,
  ///    centred, with the message beneath it.
  ///  * **A picture** — the picture, and nothing on top of it but the message,
  ///    sat at the bottom. Stacking the logo over a photograph the venue picked
  ///    obscured the thing they chose it for, which is what this fixes.
  Widget _resting(BuildContext context, {required bool overImage}) {
    final message = widget.settings.idleMessage.trim();

    final caption = message.isEmpty
        ? null
        : Text(
            message.toUpperCase(),
            textAlign: TextAlign.center,
            style: TextStyle(
              // A shade brighter over a photograph, where it competes with
              // whatever is behind it rather than with black.
              color: overImage
                  ? const Color(0xF2FFFFFF)
                  : const Color(0xCCFFFFFF),
              fontSize: overImage ? 14 : 13,
              letterSpacing: 2.4,
              fontWeight: FontWeight.w600,
            ),
          );

    return GestureDetector(
      // Opaque, so a touch anywhere on the picture counts — not only on the
      // wordmark or the caption.
      behavior: HitTestBehavior.opaque,
      onTap: _onTouch,
      child: overImage
          // SafeArea, so the caption clears a rounded corner or a notch on a
          // tablet rather than sitting under it.
          ? SafeArea(
              child: Align(
                alignment: Alignment.bottomCenter,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 34),
                  child: caption ?? const SizedBox.shrink(),
                ),
              ),
            )
          : Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const _Wordmark(),
                  if (caption != null) ...[const SizedBox(height: 28), caption],
                ],
              ),
            ),
    );
  }

  Widget _pad(BuildContext context) {
    final staff = ref.watch(staffListProvider).value ?? const <StaffData>[];

    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(vertical: 24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const _Wordmark(compact: true),
                const SizedBox(height: 26),

                // Nobody to sign on. Only ever reached by a commissioned till
                // whose venue has not added anyone yet: a till with no terminal
                // token signs itself out to the login screen long before it can
                // get here, so there is nothing to fix from this screen.
                //
                // "Continue to till" is the point of it. An earlier version told
                // the operator to go to Settings — from behind a lock that is
                // precisely what stops them reaching Settings. A screen that
                // states a fix it also prevents is worse than no message.
                if (staff.isEmpty) ...[
                  const _Notice(
                    icon: Icons.info_outline,
                    text:
                        'No staff have been set up yet. Add them in the back '
                        'office under People › Staff — this till picks them up '
                        'on its own, straight away.',
                  ),
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: OutlinedButton.icon(
                      onPressed: () =>
                          ref.read(staffSessionProvider.notifier).dismissIdle(),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: Colors.white,
                        side: const BorderSide(color: Color(0x66FFFFFF)),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      icon: const Icon(Icons.login, size: 18),
                      label: const Text(
                        'Continue to till',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ),
                ] else ...[
                  // The same pad the Sign On key opens. See
                  // `widgets/staff_pin_pad.dart`: it lives there rather than
                  // here precisely so the two cannot drift apart again.
                  StaffPinPad(
                    pin: _pin,
                    onKey: _key,
                    onCancel: () => setState(() => _asking = false),
                    error: _error,
                    busy: _checking,
                    rejections: _rejections,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A resolved idle background: one picture to show, and where it came from.
///
/// A local file beats the back office's upload, because a local file is a choice
/// somebody made at this terminal. [fallbackUrl] carries the venue's upload for
/// the case where that local file exists but will not decode.
class _Backdrop {
  const _Backdrop({this.file, this.url, this.fallbackUrl})
    : assert(file != null || url != null, 'A backdrop needs a source');

  final File? file;
  final String? url;

  /// Tried when [file] fails to decode. Null when there is nothing to fall back
  /// to, or when the primary source is already the upload.
  final String? fallbackUrl;

  /// Identifies this picture, so a failure can be remembered against it and a
  /// newly chosen one gets a fresh attempt.
  String get key => file?.path ?? url!;
}

/// The venue's picture, painted edge to edge.
///
/// Reports failure upwards rather than swallowing it: the screen above needs to
/// know, because a picture that will not render means the drawn brand screen
/// should take over instead of leaving a caption floating on black.
class _Background extends StatelessWidget {
  const _Background({required this.backdrop, required this.onFailed});

  final _Backdrop backdrop;
  final void Function(String source) onFailed;

  @override
  Widget build(BuildContext context) {
    final file = backdrop.file;
    if (file != null) {
      return Image.file(
        file,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) {
          final fallback = backdrop.fallbackUrl;
          if (fallback == null) {
            onFailed(backdrop.key);
            return const SizedBox.shrink();
          }
          return _network(fallback);
        },
      );
    }
    return _network(backdrop.url!);
  }

  Widget _network(String url) => Image.network(
    url,
    fit: BoxFit.cover,
    // A background that failed to load must leave the drawn brand screen
    // behind it, never a broken-image glyph on a shop floor.
    errorBuilder: (_, _, _) {
      onFailed(backdrop.key);
      return const SizedBox.shrink();
    },
  );
}

/// The wordmark over the lime rule — the splash composition, held still.
class _Wordmark extends StatelessWidget {
  const _Wordmark({this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: compact ? 220 : 380),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Image.asset(
            'assets/brand/vesopa_logo_on_dark.png',
            fit: BoxFit.contain,
            // A missing asset must not leave an exception painting the screen
            // the whole venue is looking at.
            errorBuilder: (_, _, _) => Text(
              'vesopa',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.white,
                fontSize: compact ? 30 : 46,
                fontWeight: FontWeight.w300,
                letterSpacing: 2,
              ),
            ),
          ),
          SizedBox(height: compact ? 12 : 18),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: Container(height: 3, color: Pos.brand),
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: const Color(0x1AFFFFFF),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: const Color(0x33FFFFFF)),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: Pos.brand, size: 20),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(
              color: Color(0xE6FFFFFF),
              fontSize: 14,
              height: 1.4,
            ),
          ),
        ),
      ],
    ),
  );
}

/// The PIN pad. Sized for a thumb on a counter, not for a mouse.
///
