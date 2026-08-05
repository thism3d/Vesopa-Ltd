import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/staff_session.dart';
import '../data/till_settings.dart';
import '../main.dart';
import 'theme.dart';

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
      } else if (key == '<') {
        if (_pin.isNotEmpty) _pin = _pin.substring(0, _pin.length - 1);
      } else if (_pin.length < _pinLength) {
        _pin += key;
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
      ref.read(staffSessionProvider.notifier).signOn(who);
      return;
    }

    // Always say so. An earlier version stayed silent on a four-digit miss, in
    // case a longer PIN was still being typed — which meant a mistyped PIN did
    // nothing at all, and the clerk had no idea whether the till had registered
    // the taps.
    //
    // The digits are kept rather than wiped: one wrong key is the usual mistake,
    // and backspacing it beats retyping all four.
    setState(() {
      _checking = false;
      _error = 'That PIN was not recognised. Check it, or clear and start again.';
    });
  }

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
          if (_asking)
            const ColoredBox(color: Color(0xB3000000))
          else if (overImage)
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.center,
                  end: Alignment.bottomCenter,
                  colors: [Color(0x00000000), Color(0xB3000000)],
                ),
              ),
            ),

          if (_asking) _pad(context) else _resting(context, overImage: overImage),
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
              color: overImage ? const Color(0xF2FFFFFF) : const Color(0xCCFFFFFF),
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
                  if (caption != null) ...[
                    const SizedBox(height: 28),
                    caption,
                  ],
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
                    text: 'No staff have been set up yet. Add them in the back '
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
                  Text(
                    'Enter your PIN',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 16),
                  _Dots(length: _pin.length, busy: _checking),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      style: const TextStyle(color: Pos.red, fontSize: 14),
                    ),
                  ],
                  const SizedBox(height: 20),
                  _Keypad(onKey: _key),
                  const SizedBox(height: 14),
                  TextButton(
                    onPressed: () => setState(() => _asking = false),
                    child: const Text(
                      'Cancel',
                      style: TextStyle(color: Color(0xB3FFFFFF)),
                    ),
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

/// How many digits are in, without showing what they are.
class _Dots extends StatelessWidget {
  const _Dots({required this.length, required this.busy});

  final int length;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    if (busy) {
      return const SizedBox(
        height: 22,
        width: 22,
        child: CircularProgressIndicator(strokeWidth: 2.4, color: Pos.brand),
      );
    }

    // Four slots for the common case, growing for a longer PIN so the display
    // never disagrees with what has been typed.
    final slots = length > 4 ? length : 4;
    return SizedBox(
      height: 22,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          for (var i = 0; i < slots; i++)
            Container(
              width: 14,
              height: 14,
              margin: const EdgeInsets.symmetric(horizontal: 7),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: i < length ? Pos.brand : Colors.transparent,
                border: Border.all(
                  color: i < length ? Pos.brand : const Color(0x66FFFFFF),
                  width: 1.6,
                ),
              ),
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
/// There is no Enter key. A PIN is four digits, so the fourth key *is* the
/// submit — an Enter key on a fixed-length PIN is a tap that never carries
/// information. What the bottom row carries instead is the two things a clerk
/// actually needs after a mis-tap: take one digit back, or clear the lot.
///
/// Both are worded rather than symbolic. `CL` meant nothing to anybody, and a
/// bare ⌫ next to it left the difference between them to guesswork.
class _Keypad extends StatelessWidget {
  const _Keypad({required this.onKey});

  final void Function(String key) onKey;

  @override
  Widget build(BuildContext context) {
    void press(String key) {
      // A PIN pad that gives no feedback feels broken on glass.
      HapticFeedback.selectionClick();
      onKey(key);
    }

    return Column(
      children: [
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 1.5,
          children: [
            for (final key in const ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
              _PadKey(label: key, onTap: () => press(key)),
            _PadKey(
              label: 'Clear',
              icon: Icons.close,
              onTap: () => press('CL'),
            ),
            _PadKey(label: '0', onTap: () => press('0')),
            _PadKey(
              label: 'Back',
              icon: Icons.backspace_outlined,
              onTap: () => press('<'),
            ),
          ],
        ),
      ],
    );
  }
}

class _PadKey extends StatelessWidget {
  const _PadKey({required this.label, required this.onTap, this.icon});

  final String label;
  final VoidCallback onTap;

  /// Set on Clear and Back. Both carry an icon *and* the word, so neither has to
  /// be recognised from a glyph on a busy counter.
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final isAction = icon != null;

    return Material(
      // The two action keys sit back a shade, so the digits stay the thing the
      // eye lands on.
      color: isAction ? const Color(0x14FFFFFF) : const Color(0x24FFFFFF),
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Center(
          child: isAction
              ? Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(icon, color: Colors.white, size: 20),
                    const SizedBox(height: 2),
                    Text(
                      label,
                      style: const TextStyle(
                        color: Color(0xCCFFFFFF),
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                )
              : Text(
                  label,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 26,
                    fontWeight: FontWeight.w700,
                  ),
                ),
        ),
      ),
    );
  }
}
