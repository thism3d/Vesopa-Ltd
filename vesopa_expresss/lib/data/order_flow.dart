/// One customer's visit, from "Touch to start" to their number.
///
/// A state machine rather than a stack of routes, on purpose. A kiosk has to be
/// able to go back to the start from anywhere -- the customer walked off, the
/// idle timer fired, the venue switched it off -- and "reset one value" is a
/// thing that cannot half-happen, where popping an unknown number of routes
/// can. Every screen is drawn from this state and nothing else.
///
///   attract -> orderType -> menu <-> basket -> (details) -> (payMethod)
///           -> paying -> done -> attract
///
/// THE ORDER BEING PAID FOR SURVIVES A RESTART. Its id is written to disk the
/// moment the server hands it back, and a kiosk that starts with one on disk
/// goes straight back to it: to the payment screen if the card machine is
/// still going, to the number if the money went in while it was off.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../l10n/strings.dart';
import 'api.dart';
import 'basket.dart';
import 'models.dart';
import 'session.dart';

enum FlowStep { attract, orderType, menu, basket, details, payMethod, paying, done }

@immutable
class FlowState {
  const FlowState({
    this.step = FlowStep.attract,
    this.orderType,
    this.basket = const Basket(),
    this.upsellSeen = false,
    this.name = '',
    this.order,
    this.error,
    this.busy = false,
    this.lang = Lang.en,
    this.reach = false,
    this.contrast = false,
    this.clientRef,
  });

  final FlowStep step;
  final String? orderType;
  final Basket basket;

  /// "May we suggest" is offered once per visit. Asking again every time the
  /// basket is opened is how a kiosk becomes a nag.
  final bool upsellSeen;
  final String name;
  final OrderView? order;
  final String? error;
  final bool busy;
  final Lang lang;

  /// Everything interactive in the lower part of the screen, for somebody
  /// ordering from a wheelchair or who cannot reach the top of a tall kiosk.
  final bool reach;
  final bool contrast;

  /// This basket's id, made when it is first sent and kept until it becomes an
  /// order, so a send that timed out is sent again as the same order.
  final String? clientRef;

  S get s => S(lang);

  FlowState copyWith({
    FlowStep? step,
    String? orderType,
    Basket? basket,
    bool? upsellSeen,
    String? name,
    OrderView? order,
    bool clearOrder = false,
    String? error,
    bool clearError = false,
    bool? busy,
    Lang? lang,
    bool? reach,
    bool? contrast,
    String? clientRef,
    bool clearClientRef = false,
  }) => FlowState(
    step: step ?? this.step,
    orderType: orderType ?? this.orderType,
    basket: basket ?? this.basket,
    upsellSeen: upsellSeen ?? this.upsellSeen,
    name: name ?? this.name,
    order: clearOrder ? null : (order ?? this.order),
    error: clearError ? null : (error ?? this.error),
    busy: busy ?? this.busy,
    lang: lang ?? this.lang,
    reach: reach ?? this.reach,
    contrast: contrast ?? this.contrast,
    clientRef: clearClientRef ? null : (clientRef ?? this.clientRef),
  );
}

class OrderFlow extends Notifier<FlowState> {
  static const _activeKey = 'express_active_order';
  static const _uuid = Uuid();

  Timer? _poll;
  bool _polling = false;

  ExpressApi get _api => ref.read(apiProvider);
  KioskConfig? get _config => ref.read(kioskSessionProvider).config;

  @override
  FlowState build() {
    ref.onDispose(() => _poll?.cancel());
    // The session asks before refreshing the menu under somebody.
    ref.read(kioskSessionProvider.notifier).isIdle = () => state.step == FlowStep.attract;
    Future.microtask(_resume);
    return const FlowState();
  }

  /// Back to the start, with nothing carried over -- not the basket, not the
  /// language, not the accessibility settings: those belonged to the last
  /// customer.
  void reset() {
    _stopPolling();
    state = const FlowState();
    unawaited(_forgetActive());
  }

  /// The idle timer. Never while money is moving or the number is on screen.
  void idleReset() {
    if (state.step == FlowStep.paying || state.step == FlowStep.done || state.step == FlowStep.attract) return;
    reset();
  }

  void start() {
    final c = _config;
    if (c == null) return;
    if (c.eatIn && c.takeAway) {
      state = state.copyWith(step: FlowStep.orderType, clearError: true);
    } else {
      state = state.copyWith(
        step: FlowStep.menu,
        orderType: c.eatIn ? 'eat_in' : 'take_away',
        clearError: true,
      );
    }
  }

  void chooseType(String type) =>
      state = state.copyWith(orderType: type, step: FlowStep.menu, clearError: true);

  void setLang(Lang lang) => state = state.copyWith(lang: lang);
  void toggleReach() => state = state.copyWith(reach: !state.reach);
  void toggleContrast() => state = state.copyWith(contrast: !state.contrast);

  void add(BasketLine line) =>
      state = state.copyWith(basket: state.basket.add(line), clearError: true, clearClientRef: true);

  void setQty(String key, int qty) =>
      state = state.copyWith(basket: state.basket.setQty(key, qty), clearClientRef: true);

  void openBasket() => state = state.copyWith(step: FlowStep.basket, clearError: true);
  void backToMenu() => state = state.copyWith(step: FlowStep.menu, clearError: true);
  void markUpsellSeen() => state = state.copyWith(upsellSeen: true);
  void setName(String name) => state = state.copyWith(name: name);

  /// Pay was pressed on the basket.
  Future<void> checkout() async {
    final c = _config;
    if (c == null || state.basket.isEmpty) return;
    if (c.askName && state.name.trim().isEmpty) {
      state = state.copyWith(step: FlowStep.details, clearError: true);
      return;
    }
    await choosePayment();
  }

  /// After the name, if one was asked for.
  Future<void> choosePayment() async {
    final c = _config!;
    if (c.demo) return place('card');
    if (c.payCard && c.payCounter) {
      state = state.copyWith(step: FlowStep.payMethod, clearError: true);
      return;
    }
    return place(c.payCard ? 'card' : 'counter');
  }

  Future<void> place(String payment) async {
    if (state.busy) return;
    final ref0 = state.clientRef ?? _uuid.v4();
    state = state.copyWith(busy: true, clearError: true, clientRef: ref0);
    try {
      final order = await _api.placeOrder(
        clientRef: ref0,
        orderType: state.orderType ?? 'take_away',
        payment: payment,
        name: state.name.trim().isEmpty ? null : state.name.trim(),
        lines: state.basket.toRequest(),
      );
      await _remember(order.publicId);
      _land(order);
    } on ExpressApiError catch (e) {
      state = state.copyWith(busy: false, error: e.offline ? state.s('error_generic') : e.message);
      if (e.expressOff || e.signedOut) {
        await ref.read(kioskSessionProvider.notifier).refresh(withMenu: false);
      }
    } catch (_) {
      state = state.copyWith(busy: false, error: state.s('error_generic'));
    }
  }

  /// Put an order the server has answered about on the right screen.
  void _land(OrderView order) {
    if (order.stage.finished) {
      _stopPolling();
      state = state.copyWith(step: FlowStep.done, order: order, busy: false, clearClientRef: true);
      unawaited(_forgetActive());
      return;
    }
    if (order.stage == PayStage.cancelled) {
      _stopPolling();
      // The order is dead; the basket is not. Paying again makes a new order.
      state = state.copyWith(step: FlowStep.basket, busy: false, clearOrder: true, clearClientRef: true);
      unawaited(_forgetActive());
      return;
    }
    state = state.copyWith(step: FlowStep.paying, order: order, busy: false);
    _startPolling();
  }

  void _startPolling() {
    if (_poll != null) return;
    _poll = Timer.periodic(const Duration(milliseconds: 1500), (_) => _pollOnce());
  }

  void _stopPolling() {
    _poll?.cancel();
    _poll = null;
  }

  Future<void> _pollOnce() async {
    final order = state.order;
    if (order == null || _polling) return;
    _polling = true;
    try {
      final fresh = await _api.order(order.publicId);
      if (ref.mounted && state.order?.publicId == fresh.publicId) _land(fresh);
    } catch (_) {
      // A missed poll is the next poll's problem. The server holds the truth.
    } finally {
      _polling = false;
    }
  }

  Future<void> retryPayment() async {
    final order = state.order;
    if (order == null || state.busy) return;
    state = state.copyWith(busy: true, clearError: true);
    try {
      _land(await _api.retry(order.publicId));
    } on ExpressApiError catch (e) {
      state = state.copyWith(busy: false, error: e.message);
    }
  }

  Future<void> cancelPayment() async {
    final order = state.order;
    if (order == null || state.busy) return;
    state = state.copyWith(busy: true, clearError: true);
    try {
      _land(await _api.cancel(order.publicId));
    } on ExpressApiError catch (e) {
      state = state.copyWith(
        busy: false,
        error: e.code == 'in_progress' ? state.s('in_progress') : e.message,
      );
    }
  }

  Future<void> _remember(String publicId) async =>
      (await SharedPreferences.getInstance()).setString(_activeKey, publicId);

  Future<void> _forgetActive() async =>
      (await SharedPreferences.getInstance()).remove(_activeKey);

  /// A kiosk switched off or crashed mid-payment picks up where it was.
  Future<void> _resume() async {
    final id = (await SharedPreferences.getInstance()).getString(_activeKey);
    if (id == null || !ref.mounted) return;
    // Wait for the session to have a token before asking.
    for (var i = 0; i < 20 && _api.token == null; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    try {
      final order = await _api.order(id);
      if (order.stage == PayStage.cancelled || order.status == 'failed') {
        await _forgetActive();
        return;
      }
      state = state.copyWith(order: order, orderType: order.orderType);
      _land(order);
    } catch (_) {
      // Unknown to the server or unreachable: nothing to resume into.
    }
  }
}

final orderFlowProvider = NotifierProvider<OrderFlow, FlowState>(OrderFlow.new);
