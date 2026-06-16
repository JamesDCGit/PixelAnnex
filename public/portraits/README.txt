PixelAnnex — leader portraits (Phase 2C)
========================================

Drop operator-supplied leader portraits here. They appear in:
  - the conquest-fall popup (winner vs loser, big modal)
  - the conquest-event + victory activity cards
  - (once wired) the world-conquest win modal

FILE SPEC
---------
  - Format:   PNG (transparent or solid background both fine)
  - Size:     64 x 64 px  (square; rendered crisp with image-rendering:pixelated
              if you keep it pixel-art, or smooth if you don't)
  - Name:     <numeric country id>.png   e.g.  840.png = USA
  - Location: public/portraits/

A missing portrait automatically falls back to the country's flag, so you can add
them incrementally — no code change needed to start showing one, just drop the
file and redeploy.

COUNTRY IDs (ISO 3166-1 numeric) — the 33 "notable" countries
-------------------------------------------------------------
  840 USA            156 China          643 Russia         826 United Kingdom
  276 Germany        250 France         392 Japan          356 India
  076 Brazil         036 Australia      124 Canada         380 Italy
  724 Spain          484 Mexico         410 South Korea    364 Iran
  376 Israel         792 Turkey         682 Saudi Arabia   360 Indonesia
  586 Pakistan       408 North Korea    804 Ukraine        616 Poland
  710 South Africa   818 Egypt          566 Nigeria        032 Argentina
  170 Colombia       764 Thailand       704 Vietnam        275 Palestine
  158 Taiwan

  NOTE: file names use the id WITHOUT leading zeros — e.g. Brazil = 76.png
  (not 076.png), Australia = 36.png, Argentina = 32.png. The in-game ids flow
  unpadded; the loader requests /portraits/76.png.

SHARING PORTRAITS (non-notable countries)
-----------------------------------------
Smaller countries can reuse a notable leader's portrait. In pixelworld_v5.html,
add entries to PORTRAIT_ARCHETYPE:  { "<countryId>": "<portraitId>", ... }
e.g.  '40': '276'   // Austria uses the Germany portrait
Tell me which mappings you want (or a regional default) and I'll fill it in.
