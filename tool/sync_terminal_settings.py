"""Copy the till's terminal settings sync and access key dialog to the other apps.

    python tool/sync_terminal_settings.py

vesopa_epos/lib/data/terminal_sync.dart is the source: edit it there, then run
this. Each app keeps its own copy, as with the sign-in code, so one app's
release cannot break another; only what differs per app is replaced below.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vesopa_epos/lib/data/terminal_sync.dart"
DIALOG = ROOT / "vesopa_epos_kitchen/lib/ui/access_key_dialog.dart"

DISPLAY_KEYS = [
    "advert_folder", "advert_volume", "bill_on_right", "bill_share", "child_lock",
    "customer_qr", "customer_qr_caption", "dwell_seconds", "fill_screen",
    "fill_screen_video", "full_screen", "idle_seconds", "notifications",
    "sale_advert_folder", "sale_adverts_same", "screen_key", "screen_size",
    "show_prices", "special_text", "special_title", "standing_message",
    "status_hide_seconds", "thank_you", "thank_you_seconds", "tile_place", "tiles",
    "touch", "welcome_text", "zoom",
]

APPS = {
    "vesopa_epos_kitchen": {
        "kind": "kitchen",
        "import": "import '../config/constants.dart';\nimport 'app_update.dart';\n",
        "settings": {
            "vesopa_kitchen_session": "Screen",
            "kds_theme_mode": "Appearance",
            "vesopa_lan_manual": "LocalLink",
        },
        "fields": {"vesopa_kitchen_session": ["screenId", "soundOverride", "notify", "zoomNudge"]},
        "token": """  final raw = prefs.getString('vesopa_kitchen_session');
  if (raw == null) return null;
  try {
    return (jsonDecode(raw) as Map<String, dynamic>)['token'] as String?;
  } catch (_) {
    return null;
  }""",
        "device": "(await Installation.current(kitchenAppVersion)).deviceId",
    },
    "vesopa_epos_display": {
        "kind": "display",
        "import": "import 'pairing.dart' show displayDeviceId;\n",
        "settings": {**{f"display.{k}": "Display" for k in DISPLAY_KEYS}, "vesopa_lan_manual": "LocalLink"},
        "fields": {},
        "token": "  return prefs.getString('display.vesopa_token');",
        "device": "await displayDeviceId()",
    },
    "vesopa_go": {
        "kind": "go",
        "import": "import 'package:flutter_secure_storage/flutter_secure_storage.dart';\n",
        "settings": {
            "go_appearance": "Appearance", "go_floor_view": "Appearance", "go_full_screen": "Appearance",
            "go_idle_message": "Idle", "go_idle_shade": "Idle", "go_idle_top": "Idle",
            "go_keep_awake": "Idle", "go_card_machine": "CardMachine", "go_teya_machine": "CardMachine",
            "go_receipt_printer": "Printers", "go_kitchen_printer": "Printers",
            "go_kitchen_autoprint": "Printers", "go_sounds_muted": "Sounds",
            "vesopa_lan_manual": "LocalLink",
            **{f"go_display_{k}": "Display" for k in [
                "touch", "sound", "show_qr", "show_amount", "show_card_marks", "show_card_steps",
                "show_discount", "thanks_seconds", "text_scale",
            ]},
        },
        "fields": {},
        "token": "  return const FlutterSecureStorage().read(key: 'vesopa_go_token');",
        "device": "await const FlutterSecureStorage().read(key: 'vesopa_go_device') ?? ''",
    },
}


def dart_map(values):
    lines = "".join(f"  '{k}': {dart_value(v)},\n" for k, v in values.items())
    return "{\n" + lines + "}" if values else "{}"


def dart_value(value):
    if isinstance(value, list):
        return "{" + ", ".join(f"'{v}'" for v in value) + "}"
    return f"'{value}'"


def build(config):
    text = SOURCE.read_bytes().decode()
    text = re.sub(
        r"const Map<String, String> terminalSettings = \{.*?\n\};",
        lambda _: f"const Map<String, String> terminalSettings = {dart_map(config['settings'])};",
        text, count=1, flags=re.S)
    text = re.sub(
        r"const Map<String, Set<String>> terminalFields = \{.*?\};",
        lambda _: f"const Map<String, Set<String>> terminalFields = {dart_map(config['fields'])};",
        text, count=1, flags=re.S)
    text = text.replace("import 'terminal_identity.dart';\n", config["import"])
    text = re.sub(
        r"Future<String\?> _deviceToken\(SharedPreferences prefs\) async \{.*?\n\}\n",
        lambda _: "Future<String?> _deviceToken(SharedPreferences prefs) async {\n"
                  + config["token"] + "\n}\n",
        text, count=1, flags=re.S)
    text = text.replace("await terminalDeviceId()", config["device"])
    return text.replace("String kind = 'till'", f"String kind = '{config['kind']}'")


def main():
    for app, config in APPS.items():
        target = ROOT / app / "lib/data/terminal_sync.dart"
        target.write_bytes(build(config).encode())
        print(f"{app}: terminal_sync.dart")
        if app != "vesopa_epos_kitchen":
            (ROOT / app / "lib/ui/access_key_dialog.dart").write_bytes(DIALOG.read_bytes())
            print(f"{app}: access_key_dialog.dart")


if __name__ == "__main__":
    main()
