# The built-in fonts

Fetched by `tool/fetch_fonts.js` from Google Fonts and committed here, because a
till downloads its lettering from this back office and not from a CDN. See the
header of that script for why.

Every family below may be redistributed, which is what serving it to a till is.
Keep this file beside the fonts: the OFL requires the licence to travel with
the font, and "we deleted the licence file" is how a free font becomes an
invoice.

## SIL Open Font License 1.1

<https://openfontlicense.org/>

Bebas Neue, Fira Sans, Inter, Lato, Manrope, Montserrat, Nunito, Oswald,
Playfair Display, Poppins, Raleway, Rubik, Source Sans 3, Work Sans.

The OFL permits use, study, modification and redistribution, bundled or sold
with other software, with two conditions that matter here: the fonts are not
sold on their own, and a *modified* font is not distributed under its original
name. Vesopa does neither — the files are byte-for-byte as fetched.

## Apache License 2.0

<https://www.apache.org/licenses/LICENSE-2.0>

Roboto, Open Sans.

## The Vesopa brand faces

Orbitron, Michroma and Blinker come from `brand_assets/Fonts`, the Vesopa brand
book's own package, and are offered to every venue alongside the Google set —
Orbitron and Michroma are the brand's display faces (headlines, the logo,
product names) and Blinker is one of its two body faces. Montserrat, the other,
was already here.

All three are SIL Open Font License 1.1 in their upstream form, which is the
licence they were fetched under. They are added by
`tool/add_brand_fonts.js`, which copies them out of the brand package and
extends catalogue.json — so a brand-book update is re-run rather than re-typed.

A venue that wants its tills lettered exactly as the brand book letters
everything else now picks Orbitron and gets it. That is the whole reason these
are built in rather than left as an upload.

## Fonts a venue uploads

Not covered by any of the above. A venue that uploads its brand font is stating
that it holds a licence permitting it to install that font on its own tills;
the back office says so at the point of upload. Vesopa neither checks nor can
check the licence on a file somebody drags in, and a foundry's desktop licence
is usually counted per device — which a five-till venue should read before
uploading, not after.
