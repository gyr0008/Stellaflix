# Third-party ports

## Stellaflix-LX-Music desktop/home reference

- Upstream: `ww085213/Stellaflix-LX-Music`
- Initial reference revision: `82826df814c32853d99697c0ee60f749a2fcad79`
- Homepage refresh revision: `812e2dc2e18bbc263e61dbd0206cb765e003d6e9`
- License: GNU GPL v3 (`GPL-3.0-only`)
- Port dates: 2026-07-18 (initial), 2026-07-19 (homepage refresh)

Stellaflix's full desktop mode adapts the upstream idea of moving the existing
Electron main-window HWND between the Windows WorkerW desktop layer and an
interactive top-level window. The native attach/detach code in this project was
rewritten around the optimized edition's fail-closed WorkerW discovery, DPI
conversion, structured acknowledgements, serialized lifecycle, and cleanup
requirements.

The home dashboard adapts the upstream information hierarchy (continue,
library, daily recommendations, recent playback, today's listening, next up,
discovery, and radio entry points). Its data adapters use this project's current
multi-provider discovery, playlist, search, playback queue, and listen-history
state. Upstream LX-only server routes and the legacy standalone wallpaper
overlay were not copied.

The 2026-07-19 refresh additionally adapts the three-song "For You" strip,
stable cover-image swaps, in-place quick-card updates, daily-review hover
feedback, and compact-height scrolling/settings behavior. These features remain
implemented against Stellaflix's existing provider, weather-radio, local-library,
queue, and playback modules rather than the upstream LX/local-only data model.

After the 2026-10-31 LX source alignment, music search and playback-URL
resolution are driven by the LX-compatible user-script host (`lx-source-host.js`)
and the bundled scrapers in `lx-search.js`; the per-platform account providers
were retired. The home information hierarchy and interactions are unchanged.

The combined application remains distributed under the repository's GNU GPL v3
license. Preserve this notice and the corresponding source when redistributing
modified builds.

## LX user-script source host and bundled scrapers

- Upstream: `Mineradio-LX-Music` 1.7.0 (a Mineradio fork carrying the LX Music
  user-API runtime)
- Declared license: `GPL-3.0-only`
- Port dates: 2026-10 batch T1–T16 (source host), 2026-10 batch T15.5a (scraper
  metadata routes)

`lx-source-host.js` runs user-supplied LX `user_api` scripts inside a Node.js
`vm` sandbox: script storage under the app user-data `sources/` directory,
URL/file/APIKEY import, availability checks, batch enable/disable/delete, a
priority-ordered fallback chain, quality-downgrade probing, and an LRU resolve
cache. `lx-search.js` ports the upstream no-cookie search scrapers (tx/wy/kw/kg/mg),
playlist search variants, ranking seeds, and the circuit-breaker/cooldown cache
semantics. Upstream Mineradio-specific storage paths were translated to this
application's own user-data identity; protocol constants (`LX_*` error prefixes,
source/action whitelists, endpoint signatures) are kept verbatim as protocol
vocabulary, not branding.

## Qishui Passport Web QR authentication (retired)

- Upstream: `Wx2yZx/Stellaflix-Qishui-QR-Login`
- Reference revision: `aaadaab7d011714f94fbe45b382ba8dcc7cf17b9`
- Declared license: `GPL-3.0-only`
- Port date: 2026-07-30
- Retirement date: 2026-10-31

Stellaflix ported only the official Passport Web QR authentication boundary:
an isolated hidden Electron security host, the Qishui web signing bootstrap,
QR creation and polling, account-session cookie persistence, and the official
second-verification UI when the service requests it. The upstream whole-project
installer was not run, and no application files were wholesale replaced.

This port was retired as a whole in the 2026-10-31 LX source alignment: the
platform login chain, `qishui-api.js`, and the `qishui-auth-v6/` web security
runtime were deleted, and the already-unreferenced `qishui-audio-decryptor/`
packaging entries were removed, so no Qishui credentials are collected or
stored. The record above is kept for provenance and license attribution only.
