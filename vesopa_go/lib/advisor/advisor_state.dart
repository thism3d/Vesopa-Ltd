/// Vesopa AI on Go: who is asking, and what they have asked.
///
/// The session opens by itself with the PIN of the member of staff signed on
/// (the same PIN the device already holds for them), so a manager taps
/// Vesopa AI and is straight in. The server decides who may: a manager, or
/// somebody a manager invited by email (vesopa_server/src/go_advisor.js).
/// When the person changes, the session goes with them.
///
/// The conversation is kept on this device only, per venue and per member of
/// staff, the last 30 questions; the server keeps none of it.
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/api.dart';
import '../data/session.dart';

/// A site the person may look at.
class AdvisorSite {
  const AdvisorSite(this.id, this.name);
  final int id;
  final String name;
}

class AdvisorSession {
  const AdvisorSession({
    required this.token,
    required this.clerkId,
    required this.name,
    required this.role,
    this.site,
    this.sites = const [],
    this.canInvite = false,
    this.aiOn = false,
    this.aiWhy,
    this.suggestions = const [],
  });

  final String token;
  final int clerkId;
  final String name;

  /// 'manager' or 'invited'.
  final String role;

  /// An invite for one site: every figure is for that site.
  final int? site;
  final List<AdvisorSite> sites;
  final bool canInvite;

  /// Whether a model words the answers on this server (the figures are exact either way).
  final bool aiOn;
  final String? aiWhy;
  final List<String> suggestions;

  factory AdvisorSession.fromJson(Map<String, dynamic> j, int clerkId) => AdvisorSession(
        token: j['token'] as String,
        clerkId: clerkId,
        name: j['name'] as String? ?? '',
        role: j['role'] as String? ?? 'manager',
        site: (j['site'] as num?)?.toInt(),
        sites: [
          for (final s in (j['sites'] as List? ?? const []))
            AdvisorSite((s['id'] as num).toInt(), s['name'] as String? ?? 'Site'),
        ],
        canInvite: j['can_invite'] == true,
        aiOn: (j['ai'] as Map?)?['on'] == true,
        aiWhy: (j['ai'] as Map?)?['why'] as String?,
        suggestions: [for (final s in (j['suggestions'] as List? ?? const [])) '$s'],
      );
}

enum AdvisorPhase { idle, opening, ready, notInvited, offline, error }

class AdvisorState {
  const AdvisorState({this.phase = AdvisorPhase.idle, this.session, this.message, this.site});
  final AdvisorPhase phase;
  final AdvisorSession? session;
  final String? message;

  /// The site chosen to look at; null is every site the person may see.
  final int? site;

  AdvisorState copyWith({AdvisorPhase? phase, AdvisorSession? session, String? message, int? site, bool clearSite = false}) => AdvisorState(
        phase: phase ?? this.phase,
        session: session ?? this.session,
        message: message,
        site: clearSite ? null : (site ?? this.site),
      );
}

class AdvisorController extends Notifier<AdvisorState> {
  @override
  AdvisorState build() {
    // A new person signed on: their own session, never the last person's.
    ref.watch(tapProvider.select((s) => '${s.venue?.office}:${s.clerk?.id}'));
    return const AdvisorState();
  }

  TapApi get _api => ref.read(apiProvider);

  /// Open the session for whoever is signed on, unless it is already open.
  Future<void> open({bool force = false}) async {
    final s = ref.read(tapProvider);
    final clerk = s.clerk;
    if (clerk == null) return;
    if (!force && state.phase == AdvisorPhase.ready && state.session?.clerkId == clerk.id) return;
    if (!force && state.phase == AdvisorPhase.opening) return;
    state = state.copyWith(phase: AdvisorPhase.opening);
    try {
      final j = await _api.aiSession(clerkId: clerk.id, pin: clerk.pin);
      final session = AdvisorSession.fromJson(j, clerk.id);
      state = AdvisorState(phase: AdvisorPhase.ready, session: session, site: session.site);
    } on TapApiError catch (e) {
      state = AdvisorState(
        phase: e.body['code'] == 'not_invited' ? AdvisorPhase.notInvited : (e.status == 0 ? AdvisorPhase.offline : AdvisorPhase.error),
        message: e.message,
      );
    }
  }

  /// The code from an invite email, typed by the person it was sent to.
  Future<String?> redeem(String code) async {
    final clerk = ref.read(tapProvider).clerk;
    if (clerk == null) return 'Sign on first.';
    try {
      final j = await _api.aiRedeem(clerkId: clerk.id, pin: clerk.pin, code: code);
      final session = AdvisorSession.fromJson(j, clerk.id);
      state = AdvisorState(phase: AdvisorPhase.ready, session: session, site: session.site);
      return null;
    } on TapApiError catch (e) {
      return e.message;
    }
  }

  void chooseSite(int? site) {
    final locked = state.session?.site;
    if (locked != null) return;
    state = site == null ? state.copyWith(clearSite: true) : state.copyWith(site: site);
  }

  /// The session ran out or was withdrawn: open again once, quietly.
  Future<bool> reopenAfter(TapApiError e) async {
    if (e.status != 401 && e.status != 403) return false;
    await open(force: true);
    return state.phase == AdvisorPhase.ready;
  }
}

final advisorProvider = NotifierProvider<AdvisorController, AdvisorState>(AdvisorController.new);

// ---- the conversation ------------------------------------------------------------

class ChatTurn {
  const ChatTurn({required this.question, this.answer, this.error, required this.at});
  final String question;
  final Map<String, dynamic>? answer;
  final String? error;
  final DateTime at;

  bool get pending => answer == null && error == null;

  Map<String, Object?> toJson() => {'q': question, 'a': answer, 'e': error, 't': at.toIso8601String()};
  factory ChatTurn.fromJson(Map<String, dynamic> j) => ChatTurn(
        question: j['q'] as String? ?? '',
        answer: (j['a'] as Map?)?.cast<String, dynamic>(),
        error: j['e'] as String?,
        at: DateTime.tryParse(j['t'] as String? ?? '') ?? DateTime.now(),
      );
}

class AdvisorChat extends Notifier<List<ChatTurn>> {
  static const keep = 30;
  String _key = '';

  @override
  List<ChatTurn> build() {
    final who = ref.watch(tapProvider.select((s) => '${s.venue?.office}:${s.clerk?.id}'));
    _key = 'vesopa_ai_chat:$who';
    _restore(_key);
    return const [];
  }

  Future<void> _restore(String key) async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(key);
      if (raw == null || key != _key) return;
      final list = [for (final j in (jsonDecode(raw) as List)) ChatTurn.fromJson((j as Map).cast<String, dynamic>())];
      // Kept only what finished; a question that was on its way when the app closed is dropped.
      state = list.where((t) => !t.pending).toList();
    } catch (_) {/* nothing kept, or unreadable: start afresh */}
  }

  Future<void> _save() async {
    try {
      final done = state.where((t) => !t.pending).toList();
      final last = done.length > keep ? done.sublist(done.length - keep) : done;
      await (await SharedPreferences.getInstance()).setString(_key, jsonEncode([for (final t in last) t.toJson()]));
    } catch (_) {/* history is a convenience */}
  }

  /// What the last answered question was about, so "and yesterday?" follows on.
  Map<String, String?>? get previous {
    for (final t in state.reversed) {
      final a = t.answer;
      if (a == null) continue;
      final intent = a['intent'] as String?;
      if (intent == null || intent == 'unknown' || intent == 'read_only') return null;
      return {'intent': intent, 'period': ((a['meta'] as Map?)?['period'] as Map?)?['key'] as String?};
    }
    return null;
  }

  Future<void> ask(String question) async {
    final q = question.trim();
    if (q.isEmpty) return;
    final previous = this.previous;
    final turn = ChatTurn(question: q, at: DateTime.now());
    state = [...state, turn];
    final advisor = ref.read(advisorProvider);
    final session = advisor.session;
    ChatTurn done;
    if (session == null) {
      done = ChatTurn(question: q, error: 'Vesopa AI is not open yet.', at: turn.at);
    } else {
      try {
        final a = await _askOnce(session.token, q, previous, advisor.site);
        done = ChatTurn(question: q, answer: a, at: turn.at);
      } on TapApiError catch (e) {
        if (await ref.read(advisorProvider.notifier).reopenAfter(e)) {
          try {
            final a = await _askOnce(ref.read(advisorProvider).session!.token, q, previous, advisor.site);
            done = ChatTurn(question: q, answer: a, at: turn.at);
          } on TapApiError catch (e2) {
            done = ChatTurn(question: q, error: e2.message, at: turn.at);
          }
        } else {
          done = ChatTurn(question: q, error: e.message, at: turn.at);
        }
      }
    }
    state = [for (final t in state) identical(t, turn) ? done : t];
    await _save();
  }

  Future<Map<String, dynamic>> _askOnce(String token, String q, Map<String, String?>? previous, int? site) =>
      ref.read(apiProvider).aiAsk(token, question: q, previous: previous, site: site);

  Future<void> clear() async {
    state = const [];
    await _save();
  }
}

final advisorChatProvider = NotifierProvider<AdvisorChat, List<ChatTurn>>(AdvisorChat.new);
