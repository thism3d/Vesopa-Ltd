/// The QR orders waiting for somebody in this kitchen to pick them up.
///
/// Shaped like [TicketBoard] on purpose: a socket for speed and a poll for
/// truth. The socket says "something happened, go and look" and this re-reads
/// over HTTP; a screen that misses a push because a proxy culled an idle
/// connection is twenty seconds behind rather than blind, and a customer
/// sitting at a table waiting for food nobody has seen is the failure this
/// whole feature would be remembered for.
///
/// It holds only what is WAITING. Accepted orders belong to the ticket board —
/// the till turns them into a bill and a kitchen ticket, and that ticket is the
/// thing anybody cooks from. This strip exists for the gap before that, which
/// on the venue that asked for it was the gap in which nothing happened.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'dinein_orders.dart';
import 'kitchen_api.dart';
import 'providers.dart';

@immutable
class DineInInboxState {
  const DineInInboxState({
    this.orders = const [],
    this.busy = const {},
    this.loading = false,
    this.error,
  });

  /// Waiting orders, newest last so the oldest is the one in front of somebody.
  final List<DineInOrder> orders;

  /// The ids currently being accepted or rejected, so a card can go quiet
  /// under a thumb rather than being pressed twice.
  final Set<int> busy;

  final bool loading;

  /// Only ever shown against an empty strip. A strip with orders on it that has
  /// just failed a poll keeps the orders: they are still waiting.
  final String? error;

  bool get isEmpty => orders.isEmpty;

  DineInInboxState copyWith({
    List<DineInOrder>? orders,
    Set<int>? busy,
    bool? loading,
    String? error,
    bool clearError = false,
  }) => DineInInboxState(
    orders: orders ?? this.orders,
    busy: busy ?? this.busy,
    loading: loading ?? this.loading,
    error: clearError ? null : (error ?? this.error),
  );
}

class DineInInbox extends Notifier<DineInInboxState> {
  Timer? _poll;
  bool _fetching = false;

  /// The ids this screen has already shown, so an arrival can be announced and
  /// the ones that were already waiting at launch cannot be. Chiming for the
  /// whole list on every restart is how a venue learns to turn the sound off.
  final _seen = <int>{};

  /// Called for each order this screen has not seen before. The shell turns it
  /// into a toast.
  void Function(DineInOrder order)? onNewOrder;

  /// How often the list is re-read regardless of the socket.
  ///
  /// Twice as often as the ticket board's thirty seconds, because a QR order is
  /// a customer waiting with a phone in their hand for a screen to say their
  /// food is coming, and nothing has been cooked yet.
  static const poll = Duration(seconds: 15);

  KitchenApi get _api => ref.read(kitchenApiProvider);

  @override
  DineInInboxState build() {
    ref.onDispose(stop);
    return const DineInInboxState();
  }

  void start() {
    if (_poll != null) return;
    _poll = Timer.periodic(poll, (_) => unawaited(refresh()));
    unawaited(refresh());
  }

  void stop() {
    _poll?.cancel();
    _poll = null;
  }

  Future<void> refresh() async {
    if (_fetching) return;
    if (_api.token == null) return;
    _fetching = true;
    if (state.orders.isEmpty && state.error == null) {
      state = state.copyWith(loading: true);
    }

    try {
      final orders = await _api.dineInOrders();
      final arrived = [
        for (final o in orders)
          if (_seen.add(o.id)) o,
      ];

      // Ids that have gone are forgotten, so an order rejected and somehow
      // re-placed would announce itself again — but only after it has actually
      // left the list.
      _seen.retainWhere((id) => orders.any((o) => o.id == id));

      state = state.copyWith(
        orders: orders,
        loading: false,
        clearError: true,
      );

      final notify = onNewOrder;
      if (notify != null) {
        for (final order in arrived) {
          notify(order);
        }
      }
    } on KitchenApiError catch (e) {
      if (e.signedOut) {
        stop();
        return;
      }
      state = state.copyWith(
        loading: false,
        error: state.orders.isEmpty ? e.message : null,
      );
    } catch (e) {
      state = state.copyWith(
        loading: false,
        error: state.orders.isEmpty ? '$e' : null,
      );
    } finally {
      _fetching = false;
    }
  }

  /// Accept or reject one. Returns null on success, or a sentence to show.
  ///
  /// Not optimistic, unlike a bump. A bump is this screen's own business and
  /// can be re-sent; accepting an order is a promise made to somebody sitting
  /// at a table, and the answer that matters is the server's — including the
  /// refusal when the till or the other screen got there first, which is a
  /// normal Friday and not an error.
  Future<String?> move(DineInOrder order, String action) async {
    if (state.busy.contains(order.id)) return null;
    state = state.copyWith(busy: {...state.busy, order.id});
    try {
      await _api.moveDineInOrder(order.id, action);
      state = state.copyWith(
        orders: [
          for (final o in state.orders)
            if (o.id != order.id) o,
        ],
      );
      return null;
    } on KitchenApiError catch (e) {
      await refresh();
      return e.message;
    } catch (e) {
      return 'That did not go through. Try again in a moment.';
    } finally {
      state = state.copyWith(
        busy: {
          for (final id in state.busy)
            if (id != order.id) id,
        },
      );
    }
  }
}
