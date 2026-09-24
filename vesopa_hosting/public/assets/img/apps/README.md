Brand marks for the app catalogue.

The SVGs come from Simple Icons (https://simpleicons.org), which releases the
icon files under CC0. The marks themselves remain the trademarks of their
owners; they are used here only to identify the software each one names, which
is what an installer catalogue is for.

Each file carries its brand's own colour baked in, because they are served with
<img> and an <img> cannot inherit currentColor from the page. Re-fetch one with:

    curl -o wordpress.svg https://cdn.jsdelivr.net/npm/simple-icons@13/icons/wordpress.svg

then re-add the fill — see the COLORS table in the script that generated these.
