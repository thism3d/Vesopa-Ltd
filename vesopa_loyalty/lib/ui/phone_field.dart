import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A country a mobile number can belong to.
class Country {
  const Country(this.iso, this.name, this.dial, this.flag);
  final String iso;
  final String name;

  /// Without the plus: '44'.
  final String dial;
  final String flag;
}

/// The countries offered, the UK first (every venue is in the UK), then the
/// ones members most often come from, then the rest alphabetically.
const countries = <Country>[
  Country('GB', 'United Kingdom', '44', '🇬🇧'),
  Country('IE', 'Ireland', '353', '🇮🇪'),
  Country('BD', 'Bangladesh', '880', '🇧🇩'),
  Country('IN', 'India', '91', '🇮🇳'),
  Country('PK', 'Pakistan', '92', '🇵🇰'),
  Country('PL', 'Poland', '48', '🇵🇱'),
  Country('US', 'United States', '1', '🇺🇸'),
  Country('AU', 'Australia', '61', '🇦🇺'),
  Country('AT', 'Austria', '43', '🇦🇹'),
  Country('BE', 'Belgium', '32', '🇧🇪'),
  Country('BG', 'Bulgaria', '359', '🇧🇬'),
  Country('CA', 'Canada', '1', '🇨🇦'),
  Country('CN', 'China', '86', '🇨🇳'),
  Country('HR', 'Croatia', '385', '🇭🇷'),
  Country('CY', 'Cyprus', '357', '🇨🇾'),
  Country('CZ', 'Czechia', '420', '🇨🇿'),
  Country('DK', 'Denmark', '45', '🇩🇰'),
  Country('EG', 'Egypt', '20', '🇪🇬'),
  Country('EE', 'Estonia', '372', '🇪🇪'),
  Country('FI', 'Finland', '358', '🇫🇮'),
  Country('FR', 'France', '33', '🇫🇷'),
  Country('DE', 'Germany', '49', '🇩🇪'),
  Country('GH', 'Ghana', '233', '🇬🇭'),
  Country('GI', 'Gibraltar', '350', '🇬🇮'),
  Country('GR', 'Greece', '30', '🇬🇷'),
  Country('HK', 'Hong Kong', '852', '🇭🇰'),
  Country('HU', 'Hungary', '36', '🇭🇺'),
  Country('IS', 'Iceland', '354', '🇮🇸'),
  Country('IT', 'Italy', '39', '🇮🇹'),
  Country('JM', 'Jamaica', '1', '🇯🇲'),
  Country('JP', 'Japan', '81', '🇯🇵'),
  Country('KE', 'Kenya', '254', '🇰🇪'),
  Country('LV', 'Latvia', '371', '🇱🇻'),
  Country('LT', 'Lithuania', '370', '🇱🇹'),
  Country('LU', 'Luxembourg', '352', '🇱🇺'),
  Country('MY', 'Malaysia', '60', '🇲🇾'),
  Country('MT', 'Malta', '356', '🇲🇹'),
  Country('NL', 'Netherlands', '31', '🇳🇱'),
  Country('NZ', 'New Zealand', '64', '🇳🇿'),
  Country('NG', 'Nigeria', '234', '🇳🇬'),
  Country('NO', 'Norway', '47', '🇳🇴'),
  Country('PH', 'Philippines', '63', '🇵🇭'),
  Country('PT', 'Portugal', '351', '🇵🇹'),
  Country('RO', 'Romania', '40', '🇷🇴'),
  Country('SA', 'Saudi Arabia', '966', '🇸🇦'),
  Country('SG', 'Singapore', '65', '🇸🇬'),
  Country('SK', 'Slovakia', '421', '🇸🇰'),
  Country('SI', 'Slovenia', '386', '🇸🇮'),
  Country('ZA', 'South Africa', '27', '🇿🇦'),
  Country('ES', 'Spain', '34', '🇪🇸'),
  Country('LK', 'Sri Lanka', '94', '🇱🇰'),
  Country('SE', 'Sweden', '46', '🇸🇪'),
  Country('CH', 'Switzerland', '41', '🇨🇭'),
  Country('TR', 'Türkiye', '90', '🇹🇷'),
  Country('UA', 'Ukraine', '380', '🇺🇦'),
  Country('AE', 'United Arab Emirates', '971', '🇦🇪'),
  Country('ZW', 'Zimbabwe', '263', '🇿🇼'),
];

/// The number in international form, `+<dial><number>`, or null when it is too
/// short or long to be a mobile number.
///
/// The member decides how to type it: "07700 900123" and "7700 900123" are the
/// same UK number (the national 0 is dropped), and a number typed with its own
/// +country code or 00 prefix keeps that country whatever is picked.
String? toInternational(Country country, String typed) {
  var digits = typed.replaceAll(RegExp(r'[^\d+]'), '');
  if (digits.isEmpty) return null;
  String full;
  if (digits.startsWith('+')) {
    full = digits.substring(1).replaceAll('+', '');
  } else if (digits.startsWith('00')) {
    full = digits.substring(2);
  } else {
    if (digits.startsWith('0')) digits = digits.substring(1);
    full = country.dial + digits;
  }
  if (full.length < 8 || full.length > 15) return null;
  return '+$full';
}

/// A country button and the number, side by side. [onCountry] fires when the
/// member picks another country.
class PhoneField extends StatelessWidget {
  const PhoneField({
    super.key,
    required this.controller,
    required this.country,
    required this.onCountry,
    this.enabled = true,
    this.autofocus = false,
    this.label = 'Mobile number',
  });

  final TextEditingController controller;
  final Country country;
  final ValueChanged<Country> onCountry;
  final bool enabled;
  final bool autofocus;
  final String label;

  Future<void> _pick(BuildContext context) async {
    final picked = await showModalBottomSheet<Country>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const _CountrySheet(),
    );
    if (picked != null) onCountry(picked);
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 56,
          child: OutlinedButton(
            onPressed: enabled ? () => _pick(context) : null,
            style: OutlinedButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Text(country.flag, style: const TextStyle(fontSize: 20)),
              const SizedBox(width: 6),
              Text('+${country.dial}'),
              const Icon(Icons.arrow_drop_down, size: 20),
            ]),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: controller,
            enabled: enabled,
            autofocus: autofocus,
            keyboardType: TextInputType.phone,
            autofillHints: const [AutofillHints.telephoneNumberNational],
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d+ ()-]'))],
            decoration: InputDecoration(
              labelText: label,
              hintText: country.iso == 'GB' ? '7700 900123' : null,
              helperText: 'With or without the first 0',
            ),
          ),
        ),
      ],
    );
  }
}

class _CountrySheet extends StatefulWidget {
  const _CountrySheet();

  @override
  State<_CountrySheet> createState() => _CountrySheetState();
}

class _CountrySheetState extends State<_CountrySheet> {
  var _query = '';

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase().replaceFirst('+', '');
    final shown = q.isEmpty
        ? countries
        : countries.where((c) => c.name.toLowerCase().contains(q) || c.dial.startsWith(q) || c.iso.toLowerCase() == q).toList();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.75,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              autofocus: true,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), labelText: 'Country or code'),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          Expanded(
            child: ListView.builder(
              itemCount: shown.length,
              itemBuilder: (context, i) {
                final c = shown[i];
                return ListTile(
                  leading: Text(c.flag, style: const TextStyle(fontSize: 24)),
                  title: Text(c.name),
                  trailing: Text('+${c.dial}'),
                  onTap: () => Navigator.pop(context, c),
                );
              },
            ),
          ),
        ]),
      ),
    );
  }
}
