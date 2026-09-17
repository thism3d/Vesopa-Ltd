/**
 * Vesopa Studio's designer: one turn of building a website by talking.
 *
 * The customer says what they want; the model answers with a stream of
 * commands -- @say, @theme, @section ... -- and every command is handed to the
 * browser the moment it is complete, and a section's HTML while it is still
 * being written. So the preview is not "generate, wait, show": the customer
 * watches the nav land, the hero fill in word by word, the colours change.
 *
 * WHY A COMMAND STREAM AND NOT TOOL CALLS. Tool arguments arrive as one JSON
 * string that cannot be shown until it closes, and a whole site is ten of
 * them. Line-based commands can be applied as they arrive, and a section's
 * half-written HTML is still HTML the browser can draw.
 *
 * WHY THE CODING MODEL. Measured 2026-09-17 on Bedrock: qwen3-coder-next starts
 * in about half a second and writes about 690 characters a second of clean
 * HTML; the 235B model that words Vesopa AI's replies wrote 260.
 *
 * The model never sees the customer's account and has no tools: it can only
 * change the site the browser sent. Publishing is the customer's own button.
 */

const config = require('../config');
const kit = require('./kit');

const MAX_OUTPUT_TOKENS = 9000;

function systemPrompt({ chatLang }) {
  const talk = chatLang === 'bn' ? 'Bangla (বাংলা, Bengali script, everyday spoken style, "আপনি")' : 'natural British English';
  return `You are Vesopa Studio, the website designer inside Vesopa Cloud, a UK web-hosting company. A customer describes the website they want, usually by voice, and you build it LIVE: every line you write is applied to their preview the moment it arrives, so they watch the site appear and change. You are a talented designer: the small-business sites you make look professionally designed, with specific, warm, believable words.

WHAT YOU WRITE is a stream of commands, each starting on its own line, and nothing else -- no markdown, no code fences, no commentary:
@say <one or two short, friendly sentences to the customer in ${talk}, saying what you are doing now>
@name <the site's name>                         (when it is new or changes)
@lang <en|bn>                                    (the language the SITE is written in, when it is new or changes)
@theme {"preset":"fresh","colors":{"accent":"#2F8F4E"},"fonts":{"heading":"Fraunces","body":"Inter"},"radius":16}
@section <id> <replace|start|end|before:<id>|after:<id>>
<the complete HTML of that one section, over as many lines as it needs>
@remove <id>
@move <id> <start|end|before:<id>|after:<id>>
@ask <at most one short question to the customer, in ${talk}>
@done
Always begin with @say and finish with @done. JSON after @theme stays on one line.

HOW TO EDIT -- do exactly what was asked and no more:
- colours, fonts, "darker", "lighter", "rounder": @theme with ONLY the keys that change -- "make it green" is {"colors":{"accent":"#2F8F4E","soft":"#DDF0E2"}}. A "preset" replaces every colour and both fonts: name one only for a new site or when they ask for a completely different look.
- words, prices, a button or an image in one section: @section <that id> replace, writing the whole section again in place with everything else in it kept exactly as it was. Never @remove a section you are about to write again.
- a new part ("add opening hours"): @section <new id> after:<the section it belongs after>.
- "remove the gallery": @remove gallery. "put reviews above the menu": @move reviews before:menu.
- a new site (SITE NOW has no sections, or they ask to start again): @name, @lang, @theme, then the sections top to bottom -- nav, hero, three to six sections that suit this business, contact, footer. Starting again: @remove every old section first.
- SELECTED SECTION, when given, is what "this", "here" and "it" mean.
- If you truly cannot tell what they want, change nothing: @say and @ask.

SECTION HTML. Exactly one root element per section, carrying the section's id:
<header class="v-nav" id="nav"> for the navigation, <footer class="v-footer" id="footer"> for the footer, <section class="v-hero" id="hero"> for the hero, <section class="v-section ..." id="<id>"> for everything else. Section ids are short lowercase words (nav, hero, about, menu, services, gallery, reviews, hours, contact, faq, order, footer).
Use ONLY the classes below. No <script>, <style>, forms, inputs, iframes, <svg> or external CSS; a style attribute only for a rare small tweak.

  Every section    <div class="v-wrap"> inside the root. Bands: .v-alt (soft background), .v-dark (inverted; at most one on a page). .v-center centres text.
  Section intro    <div class="v-head"><p class="v-eyebrow">Kicker</p><h2>Heading with <em>one</em> accent word</h2><p class="v-lead">One or two sentences.</p></div>
  Buttons          <a class="v-btn" href="#contact">Order now</a>  <a class="v-btn v-ghost" href="#menu">See the menu</a>  <a class="v-link" href="#">Read more <i class="v-i" data-i="arrow"></i></a>
  Icons            <i class="v-i" data-i="NAME"></i>, NAME one of: ${Object.keys(kit.ICONS).join(', ')}
  Art (instead of a photo)  <div class="v-art" data-emoji="🥐"><span class="v-tag"><i class="v-i" data-i="star"></i> Baked at 5am</span></div>   variants .v-wide .v-square
  Photo tile       <figure class="v-ph" data-emoji="🍞"><figcaption>Sourdough</figcaption></figure>  -- an <img src="https://..."> inside only when the customer gave that image address

  nav      <header class="v-nav" id="nav"><div class="v-wrap"><a class="v-brand" href="#hero"><i class="v-i" data-i="cake"></i>Name</a><nav class="v-links"><a href="#menu">Menu</a><a href="#about">About</a><a href="#contact">Visit</a></nav><a class="v-btn" href="#contact">Order</a></div></header>
  hero     <section class="v-hero" id="hero"><div class="v-wrap v-hero-grid"><div><p class="v-eyebrow">Place · what</p><h1>Short promise with <em>one</em> accent</h1><p class="v-lead">..</p><div class="v-actions"><a class="v-btn" href="#menu">..</a><a class="v-btn v-ghost" href="#contact">..</a></div></div><div class="v-art" data-emoji="🥐"><span class="v-tag">..</span></div></div></section>
           centred, no art: <section class="v-hero v-center" id="hero"><div class="v-wrap">..</div></section>
  cards    <div class="v-grid"><div class="v-card"><div class="v-ico"><i class="v-i" data-i="leaf"></i></div><h3>..</h3><p>..</p></div>..</div>   .v-grid.v-cols-2 / .v-cols-4; one .v-card.v-feature to highlight
  split    <div class="v-wrap v-split"><div class="v-art v-square" data-emoji="👩‍🍳"></div><div>intro, <p>, <ul class="v-list"><li><i class="v-i" data-i="check"></i>..</li></ul></div></div>   .v-split.v-flip puts the art second
  numbers  <div class="v-stats"><div class="v-stat"><b>12k</b><span>loaves a year</span></div>..</div>
  menu     <div class="v-menu"><h3 class="v-menu-group">Breads</h3><div class="v-item"><h3>Country sourdough</h3><span class="v-price">£4.50</span><p>48-hour ferment, crackly crust</p></div>..</div>
  plans    <div class="v-grid"><div class="v-card v-plan"><h3>..</h3><p class="v-amount">£29<small> / month</small></p><ul class="v-list">..</ul><a class="v-btn" href="#contact">..</a></div>..</div>
  gallery  <div class="v-gallery"><figure class="v-ph" data-emoji="🥖"><figcaption>..</figcaption></figure> .. five or seven tiles</div>
  reviews  <div class="v-grid"><div class="v-card"><blockquote class="v-quote"><div class="v-stars">★★★★★</div><p>“..”</p><cite><span class="v-avatar">S</span>Sarah, Mumbles</cite></blockquote></div>..</div>
  hours    <ul class="v-hours"><li><span>Monday – Friday</span><span>7am – 4pm</span></li>..</ul>
  contact  <div class="v-contact"><p><i class="v-i" data-i="pin"></i>Your street, Your town</p><a href="tel:01234567890"><i class="v-i" data-i="phone"></i>01234 567890</a><a href="mailto:hello@yourdomain.co.uk"><i class="v-i" data-i="mail"></i>hello@yourdomain.co.uk</a></div>
  map      <a class="v-map" href="https://maps.google.com/?q=Swansea"><i class="v-i" data-i="pin"></i>Open in Maps</a>
  faq      <div class="v-faq"><details><summary>Question?</summary><p>Answer.</p></details>..</div>
  cta      <div class="v-cta"><div><h2>..</h2><p>..</p></div><a class="v-btn" href="#contact">..</a></div>
  footer   <footer class="v-footer" id="footer"><div class="v-wrap"><a class="v-brand" href="#hero">Name</a><nav class="v-links"><a href="#menu">Menu</a>..</nav><div class="v-social"><a href="#" aria-label="Instagram"><i class="v-i" data-i="instagram"></i></a></div><p>© ${new Date().getFullYear()} Name</p></div></footer>

The examples above are for a bakery: never copy their words, emoji, icons or look onto another kind of business.

DESIGN. Choose the preset that suits the business: ${Object.entries(kit.PRESETS).map(([k, p]) => `${k} (${p.label})`).join(', ')}. As a guide: bakery, café, deli -> bakery; restaurant, curry house, takeaway -> spice; barber, tattoo, gym, garage -> midnight or bold; salon, beauty, florist, weddings -> blush; plumber, cleaner, builder, dentist -> coastal or fresh; photographer, designer, architect, lawyer -> studio; tech, apps, agencies -> lime or midnight; shops and anything cheerful -> bold. Change the accent if they name a colour. Pick emoji and icons for THIS business. Fonts only from: ${Object.keys(kit.FONTS).join(', ')}. Give the page rhythm: alternate plain and .v-alt bands, at most one .v-dark. Every nav link points at a section id that exists. Emoji art should be one fitting emoji, not decoration everywhere.

WORDS. Specific and believable for THIS business: short sentences, concrete details about what they sell and how, no lorem ipsum, no "Welcome to our website".
FACTS YOU DO NOT KNOW ARE NEVER MADE UP. The site goes live under the customer's name, so anything a visitor could check must come from the customer. Until they tell you, use EXACTLY these placeholders and nothing that merely looks real:
  address  Your street, Your town, Postcode      phone  01234 567890      email  hello@yourdomain.co.uk
  founding year, "since ...", years of experience, awards, ratings ("4.9 on Google"), customer numbers: leave them out
  reviews: first name and area only, and say in @ask that they are examples to swap for real ones
  prices: sensible examples, and say they are examples
The first time a site has placeholders, @ask for the real details. A story about the owner ("Rahim began baking 10 years ago") is a made-up fact too: describe the food and the approach instead.

LANGUAGE. You talk to the customer in ${talk}. Unless they say otherwise the SITE is written in English, since most customers sell in the UK; when they talk to you in Bangla, offer a Bangla site once in @ask. @lang says which language the site's own words are in.`;
}

function userMessage({ site, history, text, spoken, selected }) {
  const s = kit.normalise(site);
  const lines = [];
  lines.push('SITE NOW:');
  lines.push(`name: ${s.name || '(none yet)'}`);
  lines.push(`site language: ${s.lang}`);
  lines.push(`theme: ${JSON.stringify(s.theme)}`);
  if (s.sections.length) {
    lines.push('sections, top to bottom:');
    for (const sec of s.sections) lines.push(`[${sec.id}]\n${sec.html}`);
  } else {
    lines.push('sections: none yet -- this is a new site');
  }
  const recent = (Array.isArray(history) ? history : []).slice(-10).filter((h) => h && h.text);
  if (recent.length) {
    lines.push('');
    lines.push('CONVERSATION SO FAR:');
    for (const h of recent) lines.push(`${h.role === 'user' ? 'customer' : 'you'}: ${String(h.text).slice(0, 400)}`);
  }
  if (selected && kit.SECTION_ID.test(String(selected))) {
    lines.push('');
    lines.push(`SELECTED SECTION: ${selected}`);
  }
  lines.push('');
  lines.push(`CUSTOMER${spoken ? ' (spoken)' : ''}: ${String(text || '').slice(0, 1500)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Facts the customer never gave
// ---------------------------------------------------------------------------

/*
 * The prompt says to use placeholders for contact details, and the model
 * mostly does -- but in testing it still wrote hello@rahimsbakery.co.uk and a
 * real Swansea postcode (SA1 1AA) into a site nobody had given either to. A
 * site goes live under the customer's name, so an email address, a UK phone
 * number or a postcode that is not in their own words (or already on the
 * site they sent) becomes the placeholder, in the text and in the link.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+44\s?\(?0?\)?\s?|\b0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g;
const STREET = /\b\d{1,4}[a-zA-Z]?,?\s+(?:[A-Z][a-zA-Z'-]+\s+){1,3}(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Way|Close|Drive|Dr|Place|Pl|Square|Sq|Terrace|Row|Parade|Court|Ct|Crescent|Gardens|Hill|Walk|Green|Grove|Park|Mews|Arcade|Market|Broadway|Circus|Quay|Wharf)\b\.?/g;
const PLACEHOLDER = { email: 'hello@yourdomain.co.uk', phone: '01234 567890', postcode: 'Postcode', street: 'Your street' };

function digits(v) { return String(v).replace(/\D/g, ''); }

function guardFacts(html, known) {
  const said = String(known || '');
  const saidLower = said.toLowerCase();
  const saidDigits = digits(said);
  const saidPostcodes = said.toUpperCase().replace(/\s+/g, '');
  return String(html || '')
    .replace(EMAIL, (m) => (saidLower.includes(m.toLowerCase()) || m.toLowerCase() === PLACEHOLDER.email ? m : PLACEHOLDER.email))
    .replace(PHONE, (m) => {
      const d = digits(m);
      if (d === digits(PLACEHOLDER.phone) || (d.length >= 9 && saidDigits.includes(d.replace(/^44/, '0').replace(/^0/, '')))) return m;
      return m.startsWith('+') || /\S/.test(m) ? PLACEHOLDER.phone : m;
    })
    .replace(/tel:[^"']*/g, (m) => (digits(m) && saidDigits.includes(digits(m).replace(/^44/, '').replace(/^0/, '')) ? m : `tel:${digits(PLACEHOLDER.phone)}`))
    .replace(POSTCODE, (m) => (saidPostcodes.includes(m.replace(/\s+/g, '')) ? m : PLACEHOLDER.postcode))
    .replace(STREET, (m) => (saidLower.includes(m.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()) ? m : PLACEHOLDER.street));
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

const COMMAND = /^@(say|name|lang|theme|section|remove|move|ask|done)\b[ \t]*(.*)$/;
const WHERE = /^(replace|start|end|(before|after):[a-z][a-z0-9-]{0,30})$/;

/**
 * Turns model text into events, as it arrives.
 * @param {object} site   the site the turn started from (for merging a theme)
 * @param {(event: object) => void} emit
 */
function createParser(site, emit, known = '') {
  let buf = '';
  let section = null;
  let pendingTheme = null;
  let currentTheme = kit.normalise(site).theme;
  const said = { say: '', ask: '' };

  function finishSection() {
    if (!section) return;
    emit({ op: 'section', id: section.id, where: section.where, html: guardFacts(kit.sanitise(section.html), known), final: true });
    section = null;
  }

  function command(name, rest) {
    const arg = String(rest || '').trim();
    if (name === 'say') { if (arg) { said.say = said.say ? `${said.say} ${arg}` : arg; emit({ op: 'say', text: arg }); } return; }
    if (name === 'ask') { if (arg) { said.ask = arg; emit({ op: 'ask', text: arg }); } return; }
    if (name === 'name') { if (arg) emit({ op: 'name', name: arg.replace(/^["']|["']$/g, '').slice(0, 80) }); return; }
    if (name === 'lang') { emit({ op: 'lang', lang: /^bn/i.test(arg) ? 'bn' : 'en' }); return; }
    if (name === 'theme') { pendingTheme = arg; tryTheme(); return; }
    if (name === 'section') {
      const [id, whereRaw] = arg.split(/\s+/);
      if (!kit.SECTION_ID.test(String(id || ''))) return;
      const where = WHERE.test(String(whereRaw || '')) ? whereRaw : 'replace';
      section = { id, where, html: '' };
      emit({ op: 'section', id, where, html: '', final: false });
      return;
    }
    if (name === 'remove') { if (kit.SECTION_ID.test(arg)) emit({ op: 'remove', id: arg }); return; }
    if (name === 'move') {
      const [id, whereRaw] = arg.split(/\s+/);
      if (kit.SECTION_ID.test(String(id || '')) && WHERE.test(String(whereRaw || '')) && whereRaw !== 'replace') emit({ op: 'move', id, where: whereRaw });
    }
  }

  /** JSON after @theme is meant to be one line; allow a model that wraps it. */
  function tryTheme() {
    if (pendingTheme == null) return true;
    try {
      const parsed = JSON.parse(pendingTheme);
      currentTheme = kit.theme(parsed, currentTheme);
      emit({ op: 'theme', theme: currentTheme });
      pendingTheme = null;
      return true;
    } catch {
      if (pendingTheme.length > 1200) pendingTheme = null;
      return false;
    }
  }

  function line(raw) {
    const text = raw.replace(/\r$/, '');
    if (/^\s*```/.test(text)) return;
    const m = COMMAND.exec(text.trim());
    if (m && (!section || /^\s*@/.test(text))) {
      if (pendingTheme != null) pendingTheme = null;
      finishSection();
      command(m[1], m[2]);
      return;
    }
    if (pendingTheme != null) { pendingTheme += text; tryTheme(); return; }
    if (section) section.html += `${text}\n`;
  }

  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      // The section being written, including its unfinished last line.
      if (section && !/^\s*@/.test(buf)) {
        emit({ op: 'section', id: section.id, where: section.where, html: kit.sanitise(section.html + buf), final: false });
      }
    },
    end() {
      if (buf) line(buf);
      buf = '';
      finishSection();
      return said;
    },
  };
}

/**
 * One turn, streamed. `emit` receives each event; resolves with what was said.
 */
async function runTurn({ site, history, text, spoken, selected, chatLang, emit, signal }) {
  const body = {
    model: config.AI.STUDIO_MODEL,
    stream: true,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.6,
    messages: [
      { role: 'system', content: systemPrompt({ chatLang }) },
      { role: 'user', content: userMessage({ site, history, text, spoken, selected }) },
    ],
  };
  const res = await fetch(`${config.AI.BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.AI.API_KEY}`,
      ...(config.AI.PROJECT_ID ? { 'openai-project': config.AI.PROJECT_ID } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`studio model ${res.status}: ${detail}`), { status: res.status });
  }

  // What the customer has actually said, and what is already on their site:
  // the only places a real address or number may come from.
  const known = [
    ...(Array.isArray(history) ? history : []).filter((h) => h && h.role === 'user').map((h) => h.text),
    text,
    ...kit.normalise(site).sections.map((sec) => sec.html),
  ].join('\n');
  const parser = createParser(site, emit, known);
  const decoder = new TextDecoder();
  let sse = '';
  let chars = 0;
  for await (const part of res.body) {
    sse += decoder.decode(part, { stream: true });
    let i;
    while ((i = sse.indexOf('\n')) >= 0) {
      const raw = sse.slice(0, i).trim();
      sse = sse.slice(i + 1);
      if (!raw.startsWith('data:')) continue;
      const data = raw.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let delta = '';
      try {
        const json = JSON.parse(data);
        delta = (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) || '';
      } catch {
        continue;
      }
      if (delta) { chars += delta.length; parser.push(delta); }
    }
  }
  const said = parser.end();
  return { ...said, chars };
}

module.exports = { runTurn, createParser, systemPrompt, userMessage, guardFacts };
