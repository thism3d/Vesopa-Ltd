import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../platform/vesopa_sso.dart';
import 'activity_log.dart';
import 'api.dart';

const _tokenKey = 'metric_session_token';

final apiProvider = Provider<MetricApi>((ref) => MetricApi());

final activityLogProvider = Provider<ActivityLog>((ref) {
  final log = ActivityLog(ref.watch(apiProvider));
  ref.onDispose(log.dispose);
  return log;
});

/// The member's session token, kept on the device. Null: signed out.
class SessionNotifier extends AsyncNotifier<String?> {
  @override
  Future<String?> build() async {
    final api = ref.read(apiProvider);
    /*
     * BACK FROM VESOPA IN A BROWSER. The page left for auth.vesopa.com and has
     * just been loaded again with the code in its address; spend it before
     * anything else so the member lands signed in.
     */
    final answer = takeVesopaAnswer();
    if (answer != null && !answer.isEmpty) {
      if (answer.error != null) {
        lastSignInError = answer.error;
      } else {
        try {
          final result = await api.signIn(code: answer.code, verifier: answer.verifier, redirectUri: answer.redirectUri);
          await _save(result.token);
          api.token = result.token;
          return result.token;
        } on ApiError catch (e) {
          lastSignInError = e.message;
        }
      }
    }
    String? saved;
    try {
      saved = (await SharedPreferences.getInstance()).getString(_tokenKey);
    } catch (_) {
      saved = null;
    }
    api.token = saved;
    return saved;
  }

  /// Why the last sign-in did not work, for the sign-in page to show once.
  String? lastSignInError;

  Future<void> _save(String? token) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (token == null) {
        await prefs.remove(_tokenKey);
      } else {
        await prefs.setString(_tokenKey, token);
      }
    } catch (_) {
      // This run still works; the member signs in again next time.
    }
  }

  /// Continue with Vesopa. On the web the page leaves and this never returns.
  Future<String?> continueWithVesopa() async {
    if (vesopaClientIdFromServer.isEmpty) {
      try {
        vesopaClientIdFromServer = await ref.read(apiProvider).authClientId();
      } on ApiError catch (e) {
        return e.message;
      }
    }
    final answer = await startVesopaSignIn(slug: 'metric', venue: 'Metric Membership');
    if (answer == null) return null; // the browser has gone to Vesopa
    if (answer.error != null) return answer.error;
    try {
      final api = ref.read(apiProvider);
      final result = await api.signIn(idToken: answer.idToken);
      api.token = result.token;
      await _save(result.token);
      state = AsyncData(result.token);
      return null;
    } on ApiError catch (e) {
      return e.message;
    }
  }

  Future<void> signOut() async {
    await ref.read(activityLogProvider).flush();
    ref.read(apiProvider).token = null;
    await _save(null);
    state = const AsyncData(null);
  }
}

final sessionProvider = AsyncNotifierProvider<SessionNotifier, String?>(SessionNotifier.new);

/// The member and their cars, read fresh whenever something changes.
final accountProvider = FutureProvider<Account>((ref) async {
  final token = await ref.watch(sessionProvider.future);
  if (token == null) throw ApiError('Please sign in.', status: 401);
  try {
    return await ref.read(apiProvider).me();
  } on ApiError catch (e) {
    if (e.signedOut) await ref.read(sessionProvider.notifier).signOut();
    rethrow;
  }
});

final visitsProvider = FutureProvider<List<Visit>>((ref) async {
  await ref.watch(sessionProvider.future);
  return ref.read(apiProvider).visits();
});

final sitesProvider = FutureProvider<List<Site>>((ref) => ref.read(apiProvider).sites());
