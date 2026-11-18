/// What this customer display does, set on the device by a manager and kept in
/// the back office with its other settings (data/terminal_sync.dart).
///
/// The owner, 2026-11-18: "many options missing in the Go Display compared to
/// [the Windows] Customer Display". Everything the Windows display can be told
/// is here too, in its own words and the same sections, except what has no
/// meaning on a phone or a TV (which monitor, a Windows toast). Where the till
/// also says (the venue's thank-you, its QR, its tiles), "what the till says"
/// is the default and a value set here wins on this screen only.
library;

import 'package:shared_preferences/shared_preferences.dart';

import 'control.dart';

/// The tiles a screen can carry, in the Windows display's order and words.
const displayTiles = <String, String>{
  'clock': 'Clock',
  'date': 'Date',
  'welcome': 'Welcome',
  'special': "Today's special",
  'qr': 'QR code',
  'cards': 'Cards we take',
  'total': 'Total to pay',
};

class DisplayOptions {
  const DisplayOptions({
    this.touch = true,
    this.sound = true,
    this.showQr = true,
    this.showAmount = true,
    this.showCardMarks = true,
    this.showCardSteps = true,
    this.showDiscount = true,
    this.memberButtons = true,
    this.idleDim = 0,
    this.thanksSeconds = 0,
    this.textScale = 1.0,
    this.idleSeconds = -1,
    this.dwellSeconds = 0,
    this.advertVolume = -1,
    this.fillStills = true,
    this.fillVideos = true,
    this.showPrices = true,
    this.saleAdverts = true,
    this.billSide = 'till',
    this.billShare = 0,
    this.thankYou = '',
    this.standingMessage = '',
    this.customerQr = '',
    this.customerQrCaption = '',
    this.tiles = 'till',
    this.tilePlace = 'bottom',
    this.welcomeText = '',
    this.specialTitle = '',
    this.specialText = '',
    this.fullScreen = true,
    this.orientation = 'auto',
  });

  /// Whether a customer's touch does anything. Staff's corner always works.
  final bool touch;

  /// A chime when a payment is approved or declined.
  final bool sound;

  /// The code to pay from the customer's own phone, when the till offers one.
  final bool showQr;

  /// The amount in big figures on the pay screen.
  final bool showAmount;

  /// Which cards and wallets are taken, under the pay screen.
  final bool showCardMarks;

  /// The till's wording of what the card is doing ("Enter your PIN").
  final bool showCardSteps;

  /// Discounts and saved amounts on the bill.
  final bool showDiscount;

  /// The buttons on the waiting screen: tap a member card, scan a pass.
  final bool memberButtons;

  /// How far the adverts dim while nobody is at the screen, 0 to 80 per cent.
  final int idleDim;

  /// Seconds the thank-you stays up; 0 follows the till.
  final int thanksSeconds;

  /// The size of the words, for a screen read from further away.
  final double textScale;

  /// Seconds with no change to a bill before the adverts take the whole
  /// screen. -1 follows the till; 0 is never.
  final int idleSeconds;

  /// Seconds each picture stays up. 0: each advert's own, from the back office.
  final int dwellSeconds;

  /// How loud films play, 0 to 100. -1 follows the till (silent by default).
  final int advertVolume;

  /// Pictures fill the screen, cropping to fit; off shows the whole picture.
  final bool fillStills;

  /// The same for films, kept apart: they are usually cut to another shape.
  final bool fillVideos;

  /// Each line's price on the bill. Off hides them whatever the till says.
  final bool showPrices;

  /// Adverts beside the bill on a wide screen. Off gives the bill the screen.
  final bool saleAdverts;

  /// Which side the bill is on: 'till', 'left' or 'right'.
  final String billSide;

  /// The bill's share of a wide screen, 30 to 70 per cent. 0 follows the till.
  final int billShare;

  /// What the screen says once a sale is paid. Empty: the till's words.
  final String thankYou;

  /// The line across the bottom of the adverts. Empty: the till's.
  final String standingMessage;

  /// A code for the customer's phone, and the line under it. Empty: the till's.
  final String customerQr;
  final String customerQrCaption;

  /// The tiles, comma separated in order ([displayTiles]); 'till' follows the
  /// till and '' is none.
  final String tiles;

  /// Where the tiles sit: 'bottom' (a strip) or 'side' (a column).
  final String tilePlace;

  /// The welcome tile's line, and the special tile's heading and words.
  final String welcomeText;
  final String specialTitle;
  final String specialText;

  /// The phone's or tablet's own bars hidden, so the screen is all display.
  final bool fullScreen;

  /// 'auto', 'landscape' or 'portrait': a screen fixed to the wall.
  final String orientation;

  bool get followsTillTiles => tiles == 'till';

  List<String> get tileList => [
        for (final t in tiles.split(','))
          if (displayTiles.containsKey(t.trim())) t.trim(),
      ];

  /// The till's settings with this screen's own on top. With no till yet,
  /// the Windows display's defaults.
  TillControl applyTo(TillControl? c) {
    final till = c ??
        const TillControl(
          advertFolder: '',
          idleSeconds: 45,
          dwellSeconds: 12,
          showPrices: true,
          thankYou: 'Thank you',
          thankYouSeconds: 20,
          screenKey: '',
          fullScreen: true,
          advertVolume: 0,
          billOnRight: false,
          billShare: 50,
          fillScreen: true,
          standingMessage: '',
          customerQr: '',
          customerQrCaption: 'Scan to join',
          childLock: false,
        );
    String or(String mine, String theirs) => mine.trim().isEmpty ? theirs : mine.trim();
    return TillControl(
      advertFolder: till.advertFolder,
      idleSeconds: idleSeconds >= 0 ? idleSeconds : till.idleSeconds,
      dwellSeconds: dwellSeconds > 0 ? dwellSeconds : 0,
      showPrices: showPrices && till.showPrices,
      thankYou: or(thankYou, till.thankYou),
      thankYouSeconds: thanksSeconds > 0 ? thanksSeconds : till.thankYouSeconds,
      screenKey: till.screenKey,
      fullScreen: fullScreen,
      advertVolume: advertVolume >= 0 ? advertVolume : till.advertVolume,
      billOnRight: switch (billSide) { 'left' => false, 'right' => true, _ => till.billOnRight },
      billShare: billShare > 0 ? billShare : till.billShare,
      fillScreen: fillStills,
      standingMessage: or(standingMessage, till.standingMessage),
      customerQr: or(customerQr, till.customerQr),
      customerQrCaption: customerQr.trim().isEmpty ? till.customerQrCaption : customerQrCaption.trim(),
      childLock: till.childLock,
      screenSize: till.screenSize,
      zoom: till.zoom,
      touch: till.touch,
      tiles: followsTillTiles ? till.tiles : tileList,
      tilePlace: followsTillTiles ? till.tilePlace : tilePlace,
      welcomeText: or(welcomeText, till.welcomeText),
      specialTitle: or(specialTitle, till.specialTitle),
      specialText: or(specialText, till.specialText),
    );
  }

  static const _prefix = 'go_display_';

  /// Every key this screen keeps, for terminal_sync.dart's list.
  static const keys = [
    'touch', 'sound', 'show_qr', 'show_amount', 'show_card_marks', 'show_card_steps',
    'show_discount', 'member_buttons', 'idle_dim', 'thanks_seconds', 'text_scale',
    'idle_seconds', 'dwell_seconds', 'advert_volume', 'fill_stills', 'fill_videos',
    'show_prices', 'sale_adverts', 'bill_side', 'bill_share', 'thank_you',
    'standing_message', 'customer_qr', 'customer_qr_caption', 'tiles', 'tile_place',
    'welcome_text', 'special_title', 'special_text', 'full_screen', 'orientation',
  ];

  static Future<DisplayOptions> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      bool flag(String name, bool fallback) => p.getBool('$_prefix$name') ?? fallback;
      int whole(String name, int fallback) => p.getInt('$_prefix$name') ?? fallback;
      String words(String name, String fallback) => p.getString('$_prefix$name') ?? fallback;
      String oneOf(String name, List<String> allowed) {
        final v = p.getString('$_prefix$name');
        return allowed.contains(v) ? v! : allowed.first;
      }
      return DisplayOptions(
        touch: flag('touch', true),
        sound: flag('sound', true),
        showQr: flag('show_qr', true),
        showAmount: flag('show_amount', true),
        showCardMarks: flag('show_card_marks', true),
        showCardSteps: flag('show_card_steps', true),
        showDiscount: flag('show_discount', true),
        memberButtons: flag('member_buttons', true),
        idleDim: whole('idle_dim', 0).clamp(0, 80),
        thanksSeconds: whole('thanks_seconds', 0).clamp(0, 600),
        textScale: (p.getDouble('${_prefix}text_scale') ?? 1.0).clamp(0.8, 1.6),
        idleSeconds: whole('idle_seconds', -1).clamp(-1, 3600),
        dwellSeconds: whole('dwell_seconds', 0).clamp(0, 300),
        advertVolume: whole('advert_volume', -1).clamp(-1, 100),
        fillStills: flag('fill_stills', true),
        fillVideos: flag('fill_videos', true),
        showPrices: flag('show_prices', true),
        saleAdverts: flag('sale_adverts', true),
        billSide: oneOf('bill_side', const ['till', 'left', 'right']),
        billShare: whole('bill_share', 0).clamp(0, 70),
        thankYou: words('thank_you', ''),
        standingMessage: words('standing_message', ''),
        customerQr: words('customer_qr', ''),
        customerQrCaption: words('customer_qr_caption', ''),
        tiles: words('tiles', 'till'),
        tilePlace: oneOf('tile_place', const ['bottom', 'side']),
        welcomeText: words('welcome_text', ''),
        specialTitle: words('special_title', ''),
        specialText: words('special_text', ''),
        fullScreen: flag('full_screen', true),
        orientation: oneOf('orientation', const ['auto', 'landscape', 'portrait']),
      );
    } catch (_) {
      return const DisplayOptions();
    }
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    Future<void> b(String k, bool v) => p.setBool('$_prefix$k', v);
    Future<void> i(String k, int v) => p.setInt('$_prefix$k', v);
    Future<void> s(String k, String v) => p.setString('$_prefix$k', v);
    await b('touch', touch);
    await b('sound', sound);
    await b('show_qr', showQr);
    await b('show_amount', showAmount);
    await b('show_card_marks', showCardMarks);
    await b('show_card_steps', showCardSteps);
    await b('show_discount', showDiscount);
    await b('member_buttons', memberButtons);
    await i('idle_dim', idleDim);
    await i('thanks_seconds', thanksSeconds);
    await p.setDouble('${_prefix}text_scale', textScale);
    await i('idle_seconds', idleSeconds);
    await i('dwell_seconds', dwellSeconds);
    await i('advert_volume', advertVolume);
    await b('fill_stills', fillStills);
    await b('fill_videos', fillVideos);
    await b('show_prices', showPrices);
    await b('sale_adverts', saleAdverts);
    await s('bill_side', billSide);
    await i('bill_share', billShare);
    await s('thank_you', thankYou);
    await s('standing_message', standingMessage);
    await s('customer_qr', customerQr);
    await s('customer_qr_caption', customerQrCaption);
    await s('tiles', tiles);
    await s('tile_place', tilePlace);
    await s('welcome_text', welcomeText);
    await s('special_title', specialTitle);
    await s('special_text', specialText);
    await b('full_screen', fullScreen);
    await s('orientation', orientation);
  }

  DisplayOptions copyWith({
    bool? touch,
    bool? sound,
    bool? showQr,
    bool? showAmount,
    bool? showCardMarks,
    bool? showCardSteps,
    bool? showDiscount,
    bool? memberButtons,
    int? idleDim,
    int? thanksSeconds,
    double? textScale,
    int? idleSeconds,
    int? dwellSeconds,
    int? advertVolume,
    bool? fillStills,
    bool? fillVideos,
    bool? showPrices,
    bool? saleAdverts,
    String? billSide,
    int? billShare,
    String? thankYou,
    String? standingMessage,
    String? customerQr,
    String? customerQrCaption,
    String? tiles,
    String? tilePlace,
    String? welcomeText,
    String? specialTitle,
    String? specialText,
    bool? fullScreen,
    String? orientation,
  }) => DisplayOptions(
    touch: touch ?? this.touch,
    sound: sound ?? this.sound,
    showQr: showQr ?? this.showQr,
    showAmount: showAmount ?? this.showAmount,
    showCardMarks: showCardMarks ?? this.showCardMarks,
    showCardSteps: showCardSteps ?? this.showCardSteps,
    showDiscount: showDiscount ?? this.showDiscount,
    memberButtons: memberButtons ?? this.memberButtons,
    idleDim: idleDim ?? this.idleDim,
    thanksSeconds: thanksSeconds ?? this.thanksSeconds,
    textScale: textScale ?? this.textScale,
    idleSeconds: idleSeconds ?? this.idleSeconds,
    dwellSeconds: dwellSeconds ?? this.dwellSeconds,
    advertVolume: advertVolume ?? this.advertVolume,
    fillStills: fillStills ?? this.fillStills,
    fillVideos: fillVideos ?? this.fillVideos,
    showPrices: showPrices ?? this.showPrices,
    saleAdverts: saleAdverts ?? this.saleAdverts,
    billSide: billSide ?? this.billSide,
    billShare: billShare ?? this.billShare,
    thankYou: thankYou ?? this.thankYou,
    standingMessage: standingMessage ?? this.standingMessage,
    customerQr: customerQr ?? this.customerQr,
    customerQrCaption: customerQrCaption ?? this.customerQrCaption,
    tiles: tiles ?? this.tiles,
    tilePlace: tilePlace ?? this.tilePlace,
    welcomeText: welcomeText ?? this.welcomeText,
    specialTitle: specialTitle ?? this.specialTitle,
    specialText: specialText ?? this.specialText,
    fullScreen: fullScreen ?? this.fullScreen,
    orientation: orientation ?? this.orientation,
  );
}
