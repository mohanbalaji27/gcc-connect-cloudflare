# Threat model

## Boundaries

The browser, QR contents, uploads and every request are untrusted. The API derives the actor from a server-side session and checks permissions on every route. PostgreSQL is the source of truth for bookings and QR redemptions.

## Risks and controls

| Threat | Controls | Remaining |
|---|---|---|
| Impersonation / weak sign-in | scrypt password hashes; random opaque sessions (hash stored); HTTP-only SameSite=Lax cookie, `Secure` in production; 8-hour expiry; logout and role/suspension revoke sessions; forced password change for temporary passwords; failed-attempt throttling per IP and per account | No SSO or MFA yet. In-memory throttling resets on restart and is per replica. |
| CSRF | Session-bound token required on every state-changing route | — |
| Privilege escalation | Permissions (not UI) are enforced per route; only `users.manage` can change roles; super admin cannot be removed or demoted when last; temporary-password accounts are blocked from everything except changing the password | Review the permission set with the business before go-live. |
| Double booking | Row lock on the space inside a transaction, overlap check, per-person desk overlap check, quota, idempotency keys | Add a database exclusion constraint (`btree_gist`) if you run several app replicas under heavy load. |
| QR misuse | Permanent labels carry only a space id; booking codes are 256-bit random values stored as SHA-256 hashes, scoped to one space, optionally restricted to a person, with expiry (or none), use limits and revocation; redemption is in the booking transaction | A no-expiry, unlimited code is a bearer credential: revoke it if a label is stolen. |
| Injection / XSS | Parameterised SQL only; React escapes output; bounded inputs; JSON size limits | Run dependency audits and a penetration test before production. |
| Floor-plan / data leakage | PDF served only to signed-in users with `no-store`; stored in the database, never in a public folder; API responses `no-store`; bookers' names visible only to `bookings.manage` | Floor plans can be sensitive — keep access to the database and backups tight. |
| Malicious uploads | Floor plan must start with `%PDF-` and is limited to 25 MB; it is rendered client-side by pdf.js, never executed server-side; seat import validates every field and caps size | Add malware scanning if uploads are opened up to more people. |
| Stored links and contacts | Only http(s) addresses are accepted and are opened with noopener; phone numbers are validated before they become tel: links | Review links before pasting them in. |
| Anonymous feedback | When sent anonymously the author id is never stored; managers see only the text and time | Rate-limited, but not spam-proof. |
| Meal reviews | Who can read ratings and comments is checked on the server for every request (`everyone` / `summary` / `managers`, default `summary`); anonymous reviews are read with the author column replaced by NULL in SQL, so no endpoint, manager view or export can reveal the writer; one review per person per meal per day (unique index); input validated and length-capped; rate limited | The author id is still stored on an anonymous review (needed for "one per person" and edit/remove), so someone with direct database access could see it. |
| Custom roles | A role is a bundle of permissions, default notifications and a landing experience; the permission catalogue is one server file and the browser only displays it; non-super admins can grant only permissions they hold and never the super-admin-only ones (people management); `settings.manage` and `roles.manage` belong to the super admin role and cannot be stored on anyone else; roles that people hold cannot be deleted; older permission strings are expanded, never dropped | Review role contents before assigning. |
| Issue reports | Only the reporter, the assignee and people with `issues.view_all` can read an issue (everyone else gets 404, so ids reveal nothing); "similar issue" hints return counts only; staff notes are hidden from reporters; photos are one per issue, size-capped, checked by their first bytes against the declared type, stored in the database and served with `Content-Security-Policy: sandbox`, `nosniff` and a private cache; submissions, comments, +1s and photo uploads are rate limited and submissions are idempotent | Reporters must not put personal data in a report; the "Security & access" category is read by everyone who can see the queue. |
| Notifications | Each person can only list and mark their own; a fan-out only reaches people whose permissions let them open the item and who have not switched the type off; links are internal references (`issue:<id>`), never URLs | In-app only; browser push is not implemented. |
| Username sign-in | Usernames are unique case-insensitively and cannot look like an email; the sign-in box takes either, answers an unknown name and a wrong password identically, runs the same password check in both cases and is rate limited per address and per name | A short employee ID is easier to guess than an email; keep the lockout limits and use long temporary passwords. |
| Lockout | Bootstrap super admin via environment variables on an empty database; last super admin protected | Document a break-glass reset (re-run bootstrap on a new database or reset a hash directly in SQL). |

## Before real employee data

1. Replace passwords with company SSO/MFA.
2. Privacy notice, retention rules, and approval from IT security and legal.
3. Automated, tested backups; monitoring and alerting.
4. Distributed rate limiting and a CSP review if you scale out.
