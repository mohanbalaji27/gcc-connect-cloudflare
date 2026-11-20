# Technical Interview, Viva & Leadership Defense Guide
## Master Technical Q&A for Zimmer Biomet GCC Workspace

---

### Category 1: Architecture, Infrastructure & Scalability

#### Q1: "Why did you choose Cloudflare Workers + Neon Serverless PostgreSQL instead of standard AWS EC2 or ECS with RDS?"
**Answer:**
> *"There are three compelling engineering and financial reasons:*
> 1. ***Global Edge Latency:*** *Cloudflare Workers run in V8 isolates across 300+ edge cities globally. Assets and API endpoints execute within milliseconds of the user without needing multi-region Kubernetes clusters.*
> 2. ***Serverless Scale-to-Zero Economics:*** *Traditional AWS EC2 instances or RDS clusters run 24/7, costing \$300–\$800/month even when the office is completely closed on weekends and nights. With Neon and Cloudflare Workers, compute scales down to zero when idle, lowering our infrastructure bill to nearly \$0–\$5/month.*
> 3. ***Zero Maintenance Overhead:*** *V8 isolates eliminate Linux OS patching, kernel upgrades, container orchestration failures, and SSH bastion hosts. Security patches are applied transparently at the edge by Cloudflare."*

#### Q2: "What happens if 200 employees simultaneously open the app at 9:00 AM on Monday morning? Will the database crash?"
**Answer:**
> *"No, because of two architectural safeguards:*
> 1. ***Cloudflare Hyperdrive Connection Pooling:*** *Hyperdrive maintains warm, persistent connection pools directly to Neon PostgreSQL. Even if 500 edge worker isolates spin up concurrently, Hyperdrive multiplexes these requests over a small, controlled pool of TCP/TLS connections, preventing PostgreSQL connection exhaustion (`max_connections` errors).*
> 2. ***Cache-Header Strategy & ETag Validation:*** *Static assets (JavaScript, CSS, fonts, CAD floor plan image) are cached permanently with content hashes (`Cache-Control: public, max-age=31536000, immutable`). The floor map layout is fetched once per session and cached client-side in memory."*

---

### Category 2: Concurrency, Bookings & Data Integrity

#### Q3: "How does the system prevent two employees from booking the same seat or meeting room at the exact same moment?"
**Answer:**
> *"We use pessimistic concurrency control at the database layer using PostgreSQL's native range operators and transactional locks:*
> ```sql
> SELECT 1 FROM bookings
> WHERE resource_id = $1 
>   AND status = 'confirmed'
>   AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)
> FOR UPDATE;
> ```
> *The `FOR UPDATE` clause takes an exclusive row-level lock on the resource interval. If Transaction B attempts to book an overlapping range while Transaction A is committing, Transaction B is blocked and subsequently evaluates the committed data, triggering an HTTP 409 Conflict. This guarantees zero ghost bookings or double allocations."*

#### Q4: "What happens when an employee cancels a booking? How is the floor map updated for others?"
**Answer:**
> *"When a booking is cancelled, the row status is updated to `'cancelled'` and an activity audit log entry is recorded with timestamp and actor ID.*
> *Client-side, the app utilizes our low-overhead 'Pulse' heartbeat. Whenever the browser window regains focus (`visibilitychange` event) or during periodic background pulses, the client re-evaluates the availability delta. Tooltips update in memory without requiring full floor plan re-renders."*

---

### Category 3: Security, Authentication & Compliance

#### Q5: "How are passwords stored and authenticated? Is it vulnerable to rainbow tables or brute force?"
**Answer:**
> *"We implement the Scrypt Key Derivation Function (KDF) using parameters `N=8192, r=8, p=1`, with cryptographically secure random 16-byte salts per user. Scrypt is memory-hard, making GPU- and ASIC-based rainbow table attacks computationally unfeasible.*
> *Additionally, we enforce an account lockout mechanism: after 8 consecutive failed attempts from a single device, login is temporarily suspended for 15 minutes, neutralizing automated brute-force attacks."*

#### Q6: "How do you protect against Cross-Site Scripting (XSS) and Cross-Site Request Forgery (CSRF)?"
**Answer:**
> *"We enforce defense-in-depth across three tiers:*
> 1. ***Strict Content Security Policy (CSP):*** *All inline script execution without nonces is blocked. Only sanctioned scripts, styles, and data origins are permitted.*
> 2. ***HTTP-Only, SameSite Session Cookies:*** *Session tokens are stored in `HttpOnly; SameSite=Lax; Secure` cookies that cannot be accessed or exfiltrated via JavaScript (`document.cookie`).*
> 3. ***Double-Submit CSRF Validation:*** *Every state-changing API request (`POST`, `PUT`, `PATCH`, `DELETE`) requires a cryptographic `x-csrf-token` header matching the user's active session. Requests lacking the token fail with HTTP 403 Forbidden."*

#### Q7: "Can an employee escalate their privileges by tampering with API requests to make themselves a Super Admin?"
**Answer:**
> *"No. The system uses a centralized Permission Catalog and server-side RBAC validation (`effectivePermissions` in `server/security.js`). Permissions are evaluated dynamically on the server from the employee's assigned role and individual permissions.*
> *The role-management endpoint strictly enforces that an administrator cannot grant permissions that they do not personally hold, and the `super_admin` role cannot be modified or deleted."*

---

### Category 4: Floor Plan Accuracy & Spatial Engineering

#### Q8: "How did you ensure the seats and rooms on the screen match the physical office in Bangalore?"
**Answer:**
> *"The layout was not drawn by eye. We extracted the exact vector coordinate primitives from the official Zimmer Biomet architectural CAD drawing (`OST-ID-TD-ANSR-ZB-01`, 454 CAD text elements).*
> *Each desk (`Z001` to `Z184`) and each of the 8 meeting rooms (`Cabin 1`, `Cabin 2`, `Collab Zone`, `Meeting Room A`, etc.) is mapped to normalized Cartesian percentages $(x\%, y\%)$. Furthermore, all coordinates are locked with `placed_manually = TRUE` in PostgreSQL, preventing any auto-layout algorithm from displacing them."*

#### Q9: "Why doesn't the map turn blurry when zooming in on a 4K monitor or smartphone?"
**Answer:**
> *"The floor map uses a responsive SVG vector canvas. Unlike PNG or JPEG images that pixelate upon zooming, SVG calculates geometry on the client GPU using vector math. Desks, labels, and room boundaries scale with infinite resolution whether viewed on a 390px mobile phone or a 4K conference room display."*

---

### Category 5: Operations & Cost Analysis

#### Q10: "What is the total monthly running cost for this entire platform?"
**Answer:**
> *"Estimated monthly infrastructure cost:*
> - **Cloudflare Workers:** Free tier covers up to 100,000 requests per day (Paid tier is \$5/month for 10 million requests).
> - **Neon Serverless PostgreSQL:** Free tier provides 0.5 GiB of storage and compute auto-suspend (sufficient for active GCC operations; paid scale is ~\$1.90/month per compute unit).
> - **Custom Domain & SSL:** Included free via Cloudflare.
> - **Total Estimated Cost:** **Less than \$10 / month** compared to **\$300–\$600/month** for equivalent AWS VM setups."*
