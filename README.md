# Dayfall

**Live at [dayfall.day](https://dayfall.day/)** (GitHub Pages + Cloudflare DNS; the old `azchad-commits.github.io/unstuck/` URLs 301-redirect here).

A countdown planner for people with ADHD and time blindness. Every task carries a time; tapping the time starts a timer that ends with *"You're allowed to stop."*

This is a plain static PWA — no build step, no framework. Open `index.html` over HTTPS (or `localhost`) and it works. Add Supabase keys and it syncs across devices.

Beyond the core loop (deadline → days numbered backward → one thing today → tap-to-timer → "you're allowed to stop"), the app now has: timer-end notifications + a days-left icon badge (installed PWAs), a shrinking time bar with tab-title countdown, interval cues and a screen wake lock while a timer runs, three timer-sound modes — silent, soft tick, or a sub-audible keep-alive hum (tick and hum both hold the audio channel open in the background so the alarm can play; the tick makes passing time audible and its silence at zero is the signal) — plus an independent toggle for the halfway/5-minute nudges (⋯ menu; the end alarm is never muted), a six-tone alarm + long vibration + full-screen green pulse at zero (audio is unlocked at timer start so iOS actually plays it), per-task minute editing and past/future→today moves in edit mode, a once-a-day carry-over prompt for unfinished tasks (per-item checkboxes, send them to any day this week, or let them go), a "Just the first 5" ramp on the one thing, per-task move to today/tomorrow and daily repeats (edit mode), planned-vs-spent minutes after timed tasks, a no-guilt daily recap, JSON backup export/import (menu ⋯), calendar export (⋯ menu → .ics with one 8:00 AM alerted event per day — reminders with no server), an iOS add-to-home-screen nudge (Safari never fires the install prompt), undo on carry-over moves and let-gos, an estimate-calibration hint once 5+ finished timed tasks run ≥30% over plan, a deadline-passed celebration with archive/restore, a merged today view across countdowns, a countdown switcher sheet (tap the name up top) for juggling several deadlines, week-to-week paging with month-to-day jumps, and automatic dark mode.

```
index.html              app shell + styles
app.js                  all logic (local-first storage, timer, views, sync)
config.js               ← your Supabase URL + anon key go here (blank = local-only)
manifest.webmanifest    PWA manifest
sw.js                   service worker (offline app shell)
icons/                  generated icons (tools/make-icons.py regenerates them)
supabase/schema.sql     table + Row Level Security + realtime
landing.html            marketing landing page (links to ./ — the app); self-contained, screenshots embedded
```

## 1. Put it on GitHub Pages (5 minutes)

1. Create a new GitHub repo (e.g. `unstuck`), upload everything in this folder to the root of the `main` branch.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
3. In a minute or two your app is live at `https://<your-username>.github.io/unstuck/`.

All paths are relative, so it works at a sub-path like `/unstuck/` or on a custom domain. GitHub Pages is HTTPS, which the service worker and add-to-home-screen both require.

**Install on a phone:** open the URL in Safari (iOS) → Share → *Add to Home Screen*; or Chrome (Android) → the "Add" banner the app shows, or menu → *Install app*. It opens full-screen with no browser chrome.

## 2. Turn on sync with Supabase (10 minutes)

Without keys the app is fully functional and device-local — the Sync button doesn't even appear. To sync:

1. **Create a project** at [supabase.com](https://supabase.com) (free tier is plenty). Pick a region near you.
2. **Run the schema.** Dashboard → *SQL Editor* → *New query* → paste the contents of `supabase/schema.sql` → *Run*. This creates the `plans` table, locks it down with Row Level Security so users only see their own rows, and enables realtime.
3. **Allow your app URL for magic links.** Dashboard → *Authentication → URL Configuration*:
   - **Site URL:** `https://<your-username>.github.io/unstuck/`
   - **Redirect URLs:** add the same URL (and `http://localhost:8000/` if you test locally).
4. **Copy your keys.** Dashboard → *Project Settings → API*: copy the **Project URL** and the **anon public** key into `config.js`:
   ```js
   window.UNSTUCK_CONFIG = {
     supabaseUrl: "https://xxxxxxxxxxxx.supabase.co",
     supabaseAnonKey: "eyJhbGciOi..."
   };
   ```
   The anon key is designed to be public; RLS is what protects the data. Never put the `service_role` key in the app.
5. Commit and push. Installed copies pick up new code (including `config.js`) on their next online open — the service worker is network-first for code. Still bump `CACHE` in `sw.js` when you ship so old cache entries get evicted.

Then in the app: tap **Sync** → enter your email → tap the link in the email. It opens Dayfall signed in. Do the same on a second device and both stay in step.

Free-tier magic-link emails are rate-limited (a handful per hour) and come from Supabase's shared sender. When you're ready for real users, set up custom SMTP under *Authentication → SMTP Settings* so links come from your own domain and don't land in spam.

## Dayfall Plus (paid sync)

Sync is free while `plusUrl` in `config.js` is blank. To charge for it ($19/yr):

1. **Stripe account** at stripe.com (human step: identity + bank details).
2. **Payment Link**: Stripe → Payment Links → new product "Dayfall Plus", $19/year recurring → copy the `https://buy.stripe.com/...` link.
3. **Webhook**: Stripe → Developers → Webhooks → Add endpoint → URL `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`, event `checkout.session.completed` → copy its signing secret.
4. **Deploy the function** (needs the Supabase CLI, `brew install supabase/tap/supabase`):
   ```
   supabase link --project-ref <project-ref>
   supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
5. **Flip the switch**: put the Payment Link into `plusUrl` in `config.js`, commit, push.

Mechanics: every account gets a `profiles` row (`plus` defaults false; accounts created before the schema's grandfather insert ran are `plus = true` forever). A signed-in non-Plus user sees the upgrade card in the Sync sheet instead of syncing; the app stays fully functional device-locally. Payment (matched by email) flips `plus` via the webhook; "I've upgraded — check again" in the sheet re-checks. The check fails open — network trouble never locks a payer out.

## Native app (App Store)

`native/` wraps the PWA with Capacitor 6 for the App Store ($2.99 one-time, the Goblin Tools model). Web assets ship bundled (Apple rejects thin remote wrappers); sync still talks to Supabase. The wrapper's real upgrade: the timer's end alert is scheduled with iOS via `@capacitor/local-notifications`, so "You're allowed to stop" fires **even when the app is fully closed** — impossible on the web.

Build & run locally:
```
./native/sync-www.sh                  # copy the PWA into native/www
cd native && npx cap sync ios         # push into the Xcode project
npx cap open ios                      # or: xcodebuild … -scheme App
```
Ship it (human steps, needs the Apple Developer account):
1. Open `native/ios/App/App.xcworkspace` in Xcode → target App → Signing & Capabilities → pick your Team (bundle id `day.dayfall.app`).
2. App Store Connect → New App → Dayfall, bundle `day.dayfall.app`, price $2.99, category Productivity.
3. Xcode → Product → Archive → Distribute → App Store Connect. Screenshots: run in the iPhone 16/17 Pro Max simulator, ⌘S saves PNGs.
4. Review notes: mention it's a fully functional offline countdown planner; notifications are local-only; account (email magic link) is optional.

Icon/splash sources regenerate via `python3 tools/make-icons.py` → `native/assets/`, then `cd native && npx @capacitor/assets generate --ios`.

## Plan packs

Packs are pre-written countdowns as relative-day JSON (`{pack:1, name, tasks:{"0":[{title,min,star}],…}}`); day 0 = the day it loads, deadline = the last offset. The app accepts them anywhere backups import: one-tap `?import=packs/<name>.json` (same-origin), or file import from the ⋯ menu (how paid packs arrive). Storefront: `packs.html` — free "Reset Week" lives in `packs/`; **paid packs stay out of this public repo** and are delivered by Gumroad as files.

To sell "Move Out in 24 Days" ($9, human steps): create a Gumroad account → New product → digital product, $9 → upload `dayfall-pack-move-out-24.json` (kept outside the repo) → copy the product URL into the `#buy` link in `packs.html`. Gumroad handles checkout, delivery, and VAT.

## How sync works

- **Local first.** Every change is written to `localStorage` immediately. The app never waits on the network.
- **Push.** Changed plans are marked dirty and upserted to Supabase ~1 s later. Dirty IDs survive a reload, so an offline edit gets pushed the next time you're online.
- **Pull.** On sign-in, on coming back online, and whenever the app returns to the foreground, the app fetches your plans and merges them.
- **Conflicts.** Merged *per task*, not per plan: tasks added on two devices while offline are unioned by id, a task deleted anywhere stays deleted (tombstones), and only the same task edited on both sides resolves by `updated_at` (newer wins). The server clamps any `updated_at` more than 2 minutes in the future, so a phone with a wrong clock can't win every merge.
- **Incremental pulls.** After the first sync, only rows changed since the last pull (with a 5-minute overlap) are fetched, which keeps free-tier bandwidth low.
- **Realtime.** A second device that's open receives changes live via Supabase Realtime, no refresh.
- **Sign out** keeps the local copy on the device; nothing is deleted.

## Security notes

- supabase-js is loaded from jsDelivr pinned to an exact version with a Subresource Integrity hash, so a tampered CDN file refuses to run. To upgrade: change the version in `app.js` (`LIB`), then regenerate the hash — `npm pack @supabase/supabase-js@<ver>` and `openssl dgst -sha384 -binary package/dist/umd/supabase.js | openssl base64 -A` — or fetch the CDN URL in a browser and hash it with `crypto.subtle`.
- Plan and task ids are `crypto.randomUUID()`.
- All user text is HTML-escaped before rendering. RLS is the only thing between users; never ship the `service_role` key.

## Tests

```
node tools/smoke-test.mjs   # headless Playwright: manifest, service worker, offline, timer, views, a11y basics
node tools/merge-test.mjs   # sync merge scenarios (two-device adds, deletes, star conflicts)
```

## Local development

```
python3 -m http.server 8000
# open http://localhost:8000
```

Service workers cache aggressively. In DevTools → Application → Service Workers, tick *Update on reload* while developing, or unregister it.

## Regenerating icons

```
pip install pillow
python3 tools/make-icons.py
```

## Scope

See `unstuck-spec.md` in the project. This build covers all of **P0** (plan + tasks + tap-to-timer + check-off + D/W/M + star + I'm stuck + PWA), pulls **accounts + sync** forward from Phase 2, and now includes daily repeats, timer notifications/badging, carry-over, backup export/import, and dark mode. Plan templates and helper lists remain P1. Notification caveat: on iOS the app must be installed to the home screen (16.4+) for notifications; a timer that ends while the app is fully closed can't fire one without a push server — the notification covers backgrounded tabs/apps, and reopening always lands on "You're allowed to stop."

## Review log

Reviewed with the ECC plugin's typescript-reviewer, security-reviewer, database-reviewer, a11y-architect, and silent-failure-hunter agents. Applied: per-task merge with tombstones (was whole-plan last-write-wins), server-side clock clamp, network-first service worker for code (config changes propagate), only-cache-OK responses, corrupted-state backup instead of wipe, visible "couldn't save" banner, no double beep on resumed timers, multi-tab `storage` sync, pinned + SRI'd supabase-js, UUID ids, unconditional magic-link URL cleanup, sync handlers that survive a failed library load, keyboard-reachable star button (long-press removed), accessible dialogs (role, focus trap, Escape, focus return), month cells as buttons, `aria-expanded`/`aria-pressed`, timer announcements only on start/end, undo on delete, focus-visible styles, contrast fixes, reduced-motion scroll. Deferred: hard-deleting old tombstoned rows.
