## 1.0.0 - 2026-05-25

### Features
- Sign-in countdown mode — replaces time window, adds "Start Sign-in" button with 30-minute countdown
- Class archive/unarchive — teachers can archive and restore classes
- History sessions pagination — 10 per page with next/prev navigation
- Student sign-in search supports Pinyin initials and full spelling (type `csy` to match 陈思源)
- Student sign-in IP restriction — same IP can only sign in once per session
- Auto-clear student tags after successful sign-in
- Enter key submit on sign-in page — auto-signin for matched single student
- Preset tags managed via database — admin can add/edit/delete preset tags
- SSE real-time push for preset tag changes with cascading student tag updates
- Seat table tag management — click roster item to open tag popup
- "Last Seat" button on seat table — view previous session seating and changes
- Seat comparison distinguishes seat changes (yellow) from new sign-ins (blue)
- Seat table shows administrative class + student tags in history sessions
- Admin preset tag management + sign-in status on dashboard
- Manual student add functionality

### Fixes
- Multiple security fixes — CSRF, XSS, Excel injection, timing attacks
- Sign-in concurrency race condition protection + auto-archive after countdown expiry
- SSE ERR_INVALID_HTTP_RESPONSE fix
- Audit fixes — pagination, caching, rate limiting
- Global rate limit adjusted to 10000/min, resolves 429 errors in classroom multi-browser setup
- History session modal fixed height, no layout jitter on pagination
- Analytics `$queryRaw` BigInt mixed type error fix
- Frontend null pointer crashes + NaN checks
- Tag edit popup centering + duplicate name validation
- Allow duplicate class names + auto-clean tags on student transfer
- Sign-in name space matching fix + studentIp migration to prevent IP bypass

### Performance
- Eliminated N+1 queries — merged duplicate queries, added database indexes
- Large transaction splitting + parallel bcrypt hashing
- SSE caching + transaction inlining

### Refactor
- Removed dead fields from SignInConfig (startTime/endTime) and unused code
- Unified sign-in tag clearing logic (only custom tags cleared, preset tags preserved)

### Style
- Sign-in page redesigned — vertical layout, theme switching, clock component
- Unified admin panel styles — extracted shared admin.css
- Sign-in buttons, tags, typography refinements
