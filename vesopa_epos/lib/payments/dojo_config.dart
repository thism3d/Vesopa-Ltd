import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Which card platform a base URL belongs to.
///
/// Dojo and Paymentsense Connect are two different APIs behind one brand, and
/// they are not interchangeable: Dojo speaks payment *intents* on one shared
/// host and routes by the key, Connect gives every merchant their own host and
/// drives the PDQ directly. The base URL is what tells them apart, which is
/// why it has to be configurable rather than compiled in.
enum CardPlatform {
  /// `api.dojo.tech` — payment intents, terminal sessions, hosted checkout.
  dojo,

  /// `<account>.connect.paymentsense.cloud` — Pay At Counter over REST.
  connect;

  /// Work out the platform from a base URL. Anything that is not obviously a
  /// Connect host is treated as Dojo, because that is the older default and a
  /// misconfigured URL should fail loudly on the first call rather than pick a
  /// protocol at random.
  static CardPlatform forUrl(String url) =>
      url.toLowerCase().contains('connect.paymentsense.cloud')
      ? CardPlatform.connect
      : CardPlatform.dojo;

  String get label => switch (this) {
    CardPlatform.dojo => 'Dojo',
    CardPlatform.connect => 'Paymentsense Connect',
  };

  /// The URL and key for this platform in the given environment, so the
  /// Settings toggle can load a matching pair with one tap.
  ///
  /// The host is always filled in — Dojo shares one host across both
  /// environments, and the Connect host is this merchant's whichever way the
  /// environment flag sits. The *key* is only ever non-blank when the build
  /// supplied one through a `--dart-define`; no key is committed, so on an
  /// ordinary build every one of these returns blank and the operator pastes
  /// the key in Settings. That is deliberate — see the SECURITY note below.
  ({String url, String key}) presetFor({required bool sandbox}) => switch (this) {
    // Dojo routes by the key, not the host: `sk_sandbox_…` vs `sk_live_…` on
    // the same `api.dojo.tech`.
    CardPlatform.dojo => (
      url: DojoConfig.dojoBaseUrl,
      key: sandbox ? DojoConfig.sandboxKey : DojoConfig.dojoLiveKey,
    ),
    // Connect issues a per-merchant host. There is no sandbox host, so a
    // sandbox key would have nowhere to go.
    CardPlatform.connect => (
      url: DojoConfig.liveBaseUrl,
      key: sandbox ? '' : DojoConfig.liveKey,
    ),
  };
}

/// Card-payment credentials for this terminal.
///
/// Held at runtime rather than baked into the APK with `--dart-define`, so a
/// till already installed on an Android device can be given its credentials on
/// the device — no rebuild, no reinstall. A build-time define still seeds the
/// default (handy for desktop dev), but anything entered in Settings overrides
/// it and persists.
class DojoConfig {
  const DojoConfig({
    this.baseUrl = sandboxBaseUrl,
    this.apiKey = defaultSandboxKey,
    this.platform = CardPlatform.dojo,
    this.terminalId = '',
    this.softwareHouseId = defaultSoftwareHouseId,
    this.resellerId = defaultResellerId,
    this.sandbox = true,
    this.walletMerchantName = '',
    this.walletMerchantId = '',
    this.walletGatewayMerchantId = '',
    this.resultSeconds = 5,
    this.fromOffice = false,
  });

  // ---- Presets ------------------------------------------------------------
  //
  // Both environments ship with their *host* configured, so choosing a platform
  // and environment in Settings fills in a URL that matches. The key is not
  // shipped: the operator pastes it, or CI bakes it in for a managed build.
  //
  // SECURITY: this repository is public, so no key is committed here. Every
  // one of these is a build-time define with a BLANK default; CI passes the
  // real values from repository secrets, and an operator can paste one in
  // Settings on a till that was built without them.
  //
  // This is also an accreditation requirement, not only good sense: Dojo's
  // pay-at-counter go-live checklist tests "POS allows configuring different
  // API Keys. The API Key should never be hard-coded", and separately requires
  // that keys are not publicly exposed. A default value in a public repository
  // fails both.
  //
  // Two keys were previously committed here and must be treated as published:
  //   * a Paymentsense Connect LIVE key — rotate it at Paymentsense;
  //   * a Dojo sandbox key — lower stakes, but rotate it in the developer
  //     portal too.
  // Removing them from the source does not remove them from git history.

  /// Dojo's sandbox. There is no separate sandbox *host*: the key decides the
  /// environment, and an `sk_sandbox_…` key on this host returns `pi_sandbox_…`
  /// intents.
  static const sandboxBaseUrl = String.fromEnvironment(
    'DOJO_SANDBOX_URL',
    defaultValue: 'https://api.dojo.tech',
  );

  /// Dojo's public sandbox key. Dojo publish this one for partner testing
  /// (Muzahid, 2026-10-09: "every venue can use the public sandbox key for the
  /// tests ... by default set this from now on"), so unlike a live key it is
  /// safe to ship: it moves test money only. A build-time define still wins.
  static const publicSandboxKey =
      'sk_sandbox_c8oLGaI__msxsXbpBDpdtwJEz_eIhfQoKHmedqgZPCdBx59zpKZLSk8OPLT0cZolbeuYJSBvzDVVsYvtpo5RkQ';

  static const sandboxKey = String.fromEnvironment(
    'DOJO_SANDBOX_API_KEY',
    defaultValue: publicSandboxKey,
  );

  /// Dojo's single host, used for both its sandbox and live keys — the key
  /// prefix (`sk_sandbox_` vs `sk_live_`) is what selects the environment, not
  /// the URL. The Dojo platform preset always loads this.
  static const dojoBaseUrl = String.fromEnvironment(
    'DOJO_BASE_URL',
    defaultValue: 'https://api.dojo.tech',
  );

  /// A Dojo *live* key (`sk_live_…`). Blank by default: this venue was issued a
  /// Paymentsense Connect account for live, not a Dojo live key, so there is
  /// nothing to ship — the operator pastes one if they ever move live onto Dojo.
  static const dojoLiveKey = String.fromEnvironment(
    'DOJO_LIVE_KEY',
    defaultValue: '',
  );

  /// The live Paymentsense Connect account. Connect issues one host per
  /// merchant — there is no shared live host — so this is specific to this
  /// venue's installation.
  static const liveBaseUrl = String.fromEnvironment(
    'DOJO_LIVE_URL',
    defaultValue: 'https://SP068110XGBLoc1.connect.paymentsense.cloud',
  );

  static const liveKey = String.fromEnvironment('DOJO_LIVE_API_KEY');

  /// The key a fresh install starts with. `DOJO_API_KEY` still overrides, for
  /// builds that inject their own.
  static const defaultSandboxKey = String.fromEnvironment(
    'DOJO_API_KEY',
    defaultValue: sandboxKey,
  );

  /// The software house id Dojo issued Vesopa.
  ///
  /// Dojo's accreditation (test sheet, 9 Oct 2026, "Identifying Headers"):
  /// the id must be hardcoded to SL942X04 and sent on EVERY request, payment
  /// intents and terminal sessions included. It is not a venue setting, so the
  /// till shows it but never lets anyone edit it. The define is only for a
  /// test build that has to impersonate another partner.
  static const lockedSoftwareHouseId = String.fromEnvironment(
    'DOJO_SOFTWARE_HOUSE_ID',
    defaultValue: 'SL942X04',
  );
  static const defaultSoftwareHouseId = lockedSoftwareHouseId;

  /// The reseller id is free text and changes per reseller. Blank by default:
  /// Dojo's sheet asks that a blank one is sent as the software house id.
  static const defaultResellerId = String.fromEnvironment(
    'DOJO_RESELLER_ID',
    defaultValue: '',
  );

  /// Dojo's own public placeholders, which older tills saved. They are read
  /// as "not set", so a till upgraded from 1.15 sends the real ids.
  static const _placeholderIds = {'softwareHouse1', 'reseller1'};

  /// How long the result of a card payment (approved, declined, busy,
  /// cancelled) stays on the till before it closes itself. Dojo asked for the
  /// result to linger; the clerk can always close it sooner.
  static const resultSecondsChoices = [5, 10, 15];

  /// Where the card API lives.
  ///
  /// Editable because it is not one value: Dojo's sandbox and live both sit on
  /// `api.dojo.tech`, but a Paymentsense Connect merchant gets their own host
  /// (`SP068110XGBLoc1.connect.paymentsense.cloud`), and a live key cannot be
  /// used without it. [platform] is chosen explicitly, not read from this.
  final String baseUrl;

  final String apiKey;

  /// The physical card machine id. Blank = no reader on this till, so the card
  /// is taken another way (in-app card entry, or on-screen checkout).
  final String terminalId;

  /// Partner credentials the acquirer issues on onboarding. Dojo's terminal
  /// endpoints require both — without `reseller-id` the call is rejected even
  /// when the software-house id is right. Connect sends the same pair as
  /// `Software-House-Id` / `Installer-Id`.
  final String softwareHouseId;
  final String resellerId;

  /// Sandbox vs live.
  ///
  /// On Dojo this does NOT change the host — the key routes the request, and
  /// the flag only tells the native SDK it is holding a sandbox intent. On
  /// Connect the host itself is the environment.
  final bool sandbox;

  // ---- Google Pay ---------------------------------------------------------
  //
  // Dojo's Android drop-in shows a Google Pay button as soon as it is handed a
  // wallet config, and hides it otherwise. That makes these three fields the
  // switch: the venue's own Google Pay merchant details, which cannot be
  // guessed or shared, so the wallet stays off until they are entered.

  /// The name the customer sees in the Google Pay sheet — the venue's trading
  /// name, not the software's.
  final String walletMerchantName;

  /// The Google Pay merchant id from the Google Pay & Wallet Console. Only
  /// required in production; Google's TEST environment accepts a blank one,
  /// which is why a sandbox till can try the wallet without one.
  final String walletMerchantId;

  /// The merchant id Dojo knows this venue by. Google encrypts the card token
  /// to the gateway against this, so a wrong value fails at authorisation
  /// rather than in the sheet.
  final String walletGatewayMerchantId;

  /// Whether the drop-in should offer Google Pay. The gateway id is what makes
  /// the token usable, so it — not the display name — is the deciding field.
  bool get walletEnabled =>
      walletMerchantName.trim().isNotEmpty &&
      walletGatewayMerchantId.trim().isNotEmpty;

  /// Which acquirer's API this till talks to.
  ///
  /// An explicit choice, not guessed from the URL: Dojo and Paymentsense Connect
  /// are two different APIs, and the operator picks which one this terminal uses
  /// in Settings. Kept alongside the URL so a mistyped host fails loudly against
  /// the chosen platform rather than silently switching APIs underneath.
  final CardPlatform platform;

  /// Seconds the payment result stays on screen: 5, 10 or 15.
  final int resultSeconds;

  /// Whether these settings came from the venue's back office
  /// (vesopaepos.com/admin › Card payments) rather than this till's Settings.
  final bool fromOffice;

  /// The software house id actually sent. On Dojo it is always Vesopa's own
  /// ([lockedSoftwareHouseId]); Connect issues its own ids, so there it is
  /// whatever was entered.
  String get effectiveSoftwareHouseId {
    if (platform == CardPlatform.dojo) return lockedSoftwareHouseId;
    final v = softwareHouseId.trim();
    return _placeholderIds.contains(v) ? '' : v;
  }

  /// The reseller id actually sent: what was entered, or the software house id
  /// when it is blank (Dojo's instruction for a blank reseller).
  String get effectiveResellerId {
    final v = resellerId.trim();
    if (v.isEmpty || _placeholderIds.contains(v)) {
      return platform == CardPlatform.dojo ? effectiveSoftwareHouseId : '';
    }
    return v;
  }

  bool get configured => apiKey.trim().isNotEmpty && baseUrl.trim().isNotEmpty;

  /// Whether the URL currently matches the chosen platform. A Dojo platform with
  /// a `connect.paymentsense.cloud` host (or the reverse) is a misconfiguration
  /// the Settings screen warns about.
  bool get urlMatchesPlatform => CardPlatform.forUrl(baseUrl) == platform;

  /// Whether the configured key is a Dojo sandbox key. Dojo sandbox keys are
  /// prefixed `sk_sandbox_`; this is what selects sandbox behaviour in the
  /// native SDK, not a host.
  bool get isSandboxKey => apiKey.trim().startsWith('sk_sandbox_') || sandbox;

  /// The base URL with any trailing slash removed, so paths can be appended
  /// without doubling the separator.
  String get normalisedBaseUrl {
    var url = baseUrl.trim();
    // A host pasted from a portal ("SP0681…paymentsense.cloud") has no scheme.
    // Assume HTTPS rather than failing with an unhelpful parse error — no card
    // API is served over plain HTTP.
    if (url.isNotEmpty && !url.contains('://')) url = 'https://$url';
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    return url;
  }

  /// Load the shipped preset for a platform + environment, moving the URL and
  /// key together so they can never be half-switched — a live key on a sandbox
  /// host, or a Dojo key against a Connect host, authenticates against nothing.
  ///
  /// The terminal id is cleared: a reader paired on one platform or environment
  /// does not exist on another.
  DojoConfig withPreset({
    required CardPlatform platform,
    required bool sandbox,
  }) {
    final preset = platform.presetFor(sandbox: sandbox);
    return copyWith(
      platform: platform,
      sandbox: sandbox,
      baseUrl: preset.url,
      apiKey: preset.key,
      terminalId: '',
    );
  }

  DojoConfig copyWith({
    String? baseUrl,
    String? apiKey,
    CardPlatform? platform,
    String? terminalId,
    String? softwareHouseId,
    String? resellerId,
    bool? sandbox,
    String? walletMerchantName,
    String? walletMerchantId,
    String? walletGatewayMerchantId,
    int? resultSeconds,
    bool? fromOffice,
  }) => DojoConfig(
    baseUrl: baseUrl ?? this.baseUrl,
    apiKey: apiKey ?? this.apiKey,
    platform: platform ?? this.platform,
    terminalId: terminalId ?? this.terminalId,
    softwareHouseId: softwareHouseId ?? this.softwareHouseId,
    resellerId: resellerId ?? this.resellerId,
    sandbox: sandbox ?? this.sandbox,
    walletMerchantName: walletMerchantName ?? this.walletMerchantName,
    walletMerchantId: walletMerchantId ?? this.walletMerchantId,
    walletGatewayMerchantId:
        walletGatewayMerchantId ?? this.walletGatewayMerchantId,
    resultSeconds: resultSeconds ?? this.resultSeconds,
    fromOffice: fromOffice ?? this.fromOffice,
  );

  Map<String, dynamic> toJson() => {
    'baseUrl': baseUrl,
    'apiKey': apiKey,
    'platform': platform.name,
    'terminalId': terminalId,
    'softwareHouseId': softwareHouseId,
    'resellerId': resellerId,
    'sandbox': sandbox,
    'walletMerchantName': walletMerchantName,
    'walletMerchantId': walletMerchantId,
    'walletGatewayMerchantId': walletGatewayMerchantId,
    'resultSeconds': resultSeconds,
    'fromOffice': fromOffice,
  };

  /// 5, 10 or 15 — anything else is rounded to the nearest choice.
  static int cleanResultSeconds(Object? v) {
    final n = v is num ? v.toInt() : int.tryParse('$v') ?? 5;
    if (n >= 15) return 15;
    if (n >= 10) return 10;
    return 5;
  }

  factory DojoConfig.fromJson(Map<String, dynamic> j) => DojoConfig(
    // Tills saved before the URL was configurable were all on Dojo's host, so
    // that is what a missing value means — not "unconfigured".
    baseUrl: (j['baseUrl'] as String?)?.trim().isNotEmpty ?? false
        ? j['baseUrl'] as String
        : sandboxBaseUrl,
    apiKey: j['apiKey'] as String? ?? '',
    // Tills saved before the platform was an explicit choice derived it from
    // the URL, so a missing value keeps that behaviour rather than defaulting a
    // live Connect till to Dojo.
    platform: switch (j['platform']) {
      'dojo' => CardPlatform.dojo,
      'connect' => CardPlatform.connect,
      _ => CardPlatform.forUrl(
        (j['baseUrl'] as String?)?.trim().isNotEmpty ?? false
            ? j['baseUrl'] as String
            : sandboxBaseUrl,
      ),
    },
    terminalId: j['terminalId'] as String? ?? '',
    // Tills saved before these existed fall back to the sandbox partner ids
    // rather than to blank, which would make the terminal call 401.
    softwareHouseId: j['softwareHouseId'] as String? ?? defaultSoftwareHouseId,
    // Dojo's placeholder "reseller1" was the old default; it now means blank,
    // which sends the software house id instead.
    resellerId: _placeholderIds.contains(j['resellerId'])
        ? ''
        : j['resellerId'] as String? ?? defaultResellerId,
    sandbox: j['sandbox'] as bool? ?? true,
    // Blank on an older till, which correctly means "no wallet configured".
    walletMerchantName: j['walletMerchantName'] as String? ?? '',
    walletMerchantId: j['walletMerchantId'] as String? ?? '',
    walletGatewayMerchantId: j['walletGatewayMerchantId'] as String? ?? '',
    resultSeconds: cleanResultSeconds(j['resultSeconds'] ?? 5),
    fromOffice: j['fromOffice'] as bool? ?? false,
  );
}

/// Persisted card config, editable from Settings. Seeds from the build-time
/// defines the first run so an APK built with the key still works out of the
/// box, then honours whatever the operator saves.
class DojoConfigController extends AsyncNotifier<DojoConfig> {
  static const _key = 'dojo_config';

  static const _seedKey = String.fromEnvironment('DOJO_API_KEY');
  static const _seedUrl = String.fromEnvironment('DOJO_BASE_URL');
  static const _seedTerminal = String.fromEnvironment('DOJO_TERMINAL_ID');
  static const _seedSoftwareHouse = String.fromEnvironment(
    'DOJO_SOFTWARE_HOUSE_ID',
  );

  @override
  Future<DojoConfig> build() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw != null) {
      try {
        return DojoConfig.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      } catch (_) {
        // Fall through to the seed on a corrupt value.
      }
    }
    return const DojoConfig().copyWith(
      baseUrl: _seedUrl.isEmpty ? null : _seedUrl,
      apiKey: _seedKey.isEmpty ? null : _seedKey,
      terminalId: _seedTerminal.isEmpty ? null : _seedTerminal,
      softwareHouseId: _seedSoftwareHouse.isEmpty ? null : _seedSoftwareHouse,
    );
  }

  Future<void> save(DojoConfig config) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(config.toJson()));
    state = AsyncData(config);
  }
}

final dojoConfigProvider =
    AsyncNotifierProvider<DojoConfigController, DojoConfig>(
      DojoConfigController.new,
    );
