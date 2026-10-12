/**
 * Where a passkey lives, in words a member recognises: "iCloud Keychain",
 * "Google Password Manager", "Windows Hello".
 *
 * WHY THIS EXISTS. A list of passkeys that all say "Passkey" is no help to
 * somebody deciding which one to remove. The authenticator says what it is in
 * its AAGUID, a fixed id per password manager, carried in every registration;
 * this is the small table of the ones people actually use. The full list is
 * the community one at github.com/passkeydeveloper/passkey-authenticator-aaguids.
 *
 * AN ALL-ZERO AAGUID IS ORDINARY, NOT BROKEN. Apple sends zeros for iCloud
 * Keychain when no attestation is asked for, which is how every passkey here is
 * made. So where the id says nothing, the device it was added on decides: a
 * passkey added on an iPhone with no other name is in iCloud Keychain, one
 * added on Android is in Google Password Manager. A guess, but the right one
 * nearly always, and better than a blank.
 */

const PROVIDERS = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  '771b48fd-d3d4-4f74-9232-fc157ab0507a': 'Edge on Mac',
};

const ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * The password manager or device a passkey is kept in, or null.
 *
 * [device] is what it was added on, as deviceLabel() words it ("iPhone",
 * "Safari on a Mac", "Android phone or tablet") or a raw User-Agent.
 */
function passkeyProvider(aaguid, device) {
  const id = String(aaguid || '').trim().toLowerCase();
  if (PROVIDERS[id]) return PROVIDERS[id];
  if (id && id !== ZERO) return null;
  const d = String(device || '');
  if (/iPhone|iPad|iPod|Mac/i.test(d)) return 'iCloud Keychain';
  if (/Android/i.test(d)) return 'Google Password Manager';
  if (/Windows/i.test(d)) return 'Windows Hello';
  return null;
}

module.exports = { passkeyProvider, PROVIDERS };
