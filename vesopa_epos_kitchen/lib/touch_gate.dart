import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';

/// Touch on or off, decided on the till (2026-10-17).
///
/// The owner: a customer display or kitchen screen may be one nobody can
/// touch, so the till can turn touch off. Off means a finger on the glass does
/// nothing at all; a mouse and keyboard plugged into that computer still work,
/// and everything can be done from the till either way. Vesopa EPOS itself is
/// always fully touch.
///
/// Done at the root, on the binding, because only there is it known what kind
/// of pointer an event came from: a widget hit test sees a position, not a
/// finger or a mouse. Touch and stylus are dropped; mouse and trackpad pass.
class TouchGate {
  TouchGate._();

  /// Set from the screen's settings whenever they change.
  static bool blocked = false;

  static bool drops(PointerEvent event) =>
      blocked &&
      (event.kind == PointerDeviceKind.touch ||
          event.kind == PointerDeviceKind.stylus ||
          event.kind == PointerDeviceKind.invertedStylus);
}

/// The app's binding, with the gate in front of every pointer event. Must be
/// created before anything else touches the binding (first line of main).
class TouchGateBinding extends WidgetsFlutterBinding {
  static bool _made = false;

  static WidgetsBinding ensureInitialized() {
    if (!_made) {
      _made = true;
      TouchGateBinding();
    }
    return WidgetsBinding.instance;
  }

  @override
  void handlePointerEvent(PointerEvent event) {
    if (TouchGate.drops(event)) return;
    super.handlePointerEvent(event);
  }
}
