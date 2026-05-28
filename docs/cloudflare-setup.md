# Cloudflare CDN setup for PixelAnnex

This puts Cloudflare in front of `pixelannex.com` so static assets
(HTML, JSON, PNGs) are served from CF's global edge instead of from the
Node process on the DigitalOcean droplet.

**Benefits at our scale (target 100 concurrent users):**
- ~99% origin offload for static assets — Node only sees first-time-per-edge requests
- TLS termination at the edge (faster handshake worldwide)
- Free DDoS protection
- Real-time analytics
- WebSocket support included on free plan

**WebSocket compatibility:** Cloudflare's free plan supports WS with a
100s idle timeout. Our `PING_MS = 10000` keep-alives well below that, so
WS works without any code changes.

## Prerequisites

- You own `pixelannex.com` and have access to the registrar.
- The site currently resolves to `134.209.74.81` (the DO droplet).
- Existing nginx + Let's Encrypt setup stays in place (CF talks to it
  over HTTPS).

## Step-by-step

### 1. Create a free Cloudflare account
- Go to https://dash.cloudflare.com/sign-up
- Use a strong password; enable 2FA.

### 2. Add `pixelannex.com` to Cloudflare
- Dashboard → **Add a Site** → enter `pixelannex.com`
- Pick the **Free plan**
- Cloudflare will scan your existing DNS records (A, MX, etc.) and import them.
- Review the imported records — you should see at minimum:
  - `A   pixelannex.com    134.209.74.81`
  - `A   www               134.209.74.81`
- For both A records, **make sure the proxy status is "Proxied" (orange cloud)**.

### 3. Update your nameservers
- Cloudflare will show you two nameservers like `nina.ns.cloudflare.com` and `rob.ns.cloudflare.com`
- Log into your domain registrar (whoever you bought `pixelannex.com` from — Namecheap, GoDaddy, Porkbun, etc.)
- Find the **Nameservers** setting for `pixelannex.com`
- Change from your registrar's default to the two Cloudflare nameservers
- Save. Propagation usually takes 5-60 minutes, sometimes up to 24h.

### 4. Verify activation
- Back in Cloudflare dashboard, click **Done, check nameservers**
- You'll get an email when activation is complete
- Once active, the dashboard shows a green ✓ next to the domain

### 5. SSL/TLS setup
- Dashboard → **SSL/TLS** → **Overview**
- Set encryption mode to **Full (strict)**
  - This means: browser → CF is HTTPS, CF → origin is HTTPS with valid cert
  - Your existing Let's Encrypt cert on the droplet is valid, so this works
- DO NOT use "Flexible" — that would expose plaintext between CF and origin

### 6. Page Rules / Cache Rules

Cloudflare's defaults handle most caching correctly because our server
already sends the right `Cache-Control` headers:

- `/countries-10m.json` → `max-age=31536000, immutable` → CF caches for 1 year
- `/flags/*.png` → `max-age=31536000, immutable` → CF caches for 1 year
- `/index.html`, `/sw.js` → `no-cache` → CF revalidates with origin every request

You only need one Cache Rule if you want HTML to be cached briefly at edge:

- Dashboard → **Caching** → **Cache Rules** → **Create Rule**
- Name: `HTML edge cache`
- When incoming requests match:
  - Hostname equals `pixelannex.com`
  - AND URI path is in `/  /index.html`
- Then:
  - **Cache eligibility** → Eligible for cache
  - **Edge TTL** → Override origin → 60 seconds
- This means CF caches HTML for 60 seconds (absorbs spikes) but new
  deploys propagate within 1 minute without manual purge.

If you skip this rule, HTML always hits origin — still fine, just slightly more origin traffic.

### 7. Verify it's working
```bash
# Should show Cloudflare in the Server header and CF-Ray ID
curl -I https://pixelannex.com

# WebSocket connection check (should show "101 Switching Protocols")
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
  -H "Sec-WebSocket-Version: 13" \
  https://pixelannex.com/
```

After your next deploy, server logs should show:
```
[+] Player N connected from <real-client-ip>
```
…instead of Cloudflare's proxy IP. This is because v79 reads the
`CF-Connecting-IP` header.

### 8. Optional: WebSocket subdomain split

If you ever notice WS latency through CF (unlikely at 100 users), you can
bypass CF for WS only:

1. Add DNS A record: `ws.pixelannex.com → 134.209.74.81` with proxy status **DNS only (gray cloud)**
2. Generate a Let's Encrypt cert for `ws.pixelannex.com` on the droplet:
   ```
   certbot --nginx -d ws.pixelannex.com
   ```
3. Add nginx server block for `ws.pixelannex.com` that proxies to Node
4. Update client code:
   ```js
   const ws = new WebSocket('wss://ws.pixelannex.com/');
   ```

Skip this for now — not needed at our scale.

## Troubleshooting

**Pages don't load after switching nameservers:**
- DNS propagation can take up to 24h. Check status with:
  ```
  dig pixelannex.com NS @8.8.8.8
  ```
- Should show your two Cloudflare nameservers.

**"Too many redirects" error:**
- SSL/TLS mode is set to "Flexible" — change to "Full (strict)".

**WebSocket fails to connect through CF:**
- Free plan should work. Check that you don't have a CSRF / CSP rule
  blocking the Upgrade header.
- Page Rules can sometimes interfere — disable any custom rules and re-test.

**Static assets not being cached:**
- Use the **Analytics → Caching** tab in CF dashboard
- Look for `cache_status: hit` vs `miss`
- If everything's `dynamic` (no cache), check that the `Cache-Control`
  header is being sent by origin. Test with `curl -I`.

**HTML cache rule doesn't update after deploy:**
- Dashboard → **Caching** → **Configuration** → **Purge Cache** → **Purge Everything**
- Or wait the 60s TTL.
- For automated purging, see Cloudflare API at
  https://developers.cloudflare.com/api/operations/zone-purge

## Future automation

When ready to automate cache purging on every deploy:
1. Create a Cloudflare API token with `Cache Purge:Edit` permission for `pixelannex.com`
2. Store in `.env` on the droplet as `CF_API_TOKEN` + `CF_ZONE_ID`
3. Add a purge call to the end of `deploy.ps1`:
   ```pwsh
   Invoke-RestMethod -Method Post `
     -Uri "https://api.cloudflare.com/client/v4/zones/$env:CF_ZONE_ID/purge_cache" `
     -Headers @{ Authorization = "Bearer $env:CF_API_TOKEN" } `
     -ContentType 'application/json' `
     -Body '{"files":["https://pixelannex.com/","https://pixelannex.com/sw.js"]}'
   ```
