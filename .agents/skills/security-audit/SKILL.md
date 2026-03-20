---
name: security-audit
description: Dedicated security audit agent that checks for OWASP vulnerabilities, secret exposure, authentication bypass, CSRF protection, input validation, dependency security, and API-specific threats. Use after ANY code change that touches authentication, API routes, user input handling, or external dependencies. More thorough than database-audit Category 10 — this is the dedicated security specialist.
---

# Security Audit Agent

This agent performs deep security analysis following OWASP guidelines, OWASP API Security Top 10, and security best practices. It goes beyond the basic security checks in database-audit Category 10 to provide comprehensive vulnerability detection.

## When to Run

- After adding/modifying API routes or endpoints
- After changing authentication or authorization logic
- After adding new user input fields or forms
- After adding/updating npm dependencies
- After modifying CSRF, session, or cookie handling
- Before any deployment/publishing
- During periodic security reviews (monthly recommended)

## Core Principle

**Assume every input is hostile, every output is visible, every dependency is compromised.** Check defense-in-depth at every layer.

---

## Category 1: Authentication & Session Security

**Goal**: Authentication is robust, sessions are secure, and there are no bypass paths.

### Steps:
1. **Session configuration**:
   ```bash
   # Check session/cookie settings
   grep -rn "cookie\|session\|httpOnly\|secure\|sameSite\|maxAge\|expires" server/ --include="*.ts"
   ```
   - Verify: `httpOnly: true`, `secure: true` (production), `sameSite: strict` or `lax`
   - Verify: Session expiry is reasonable (not indefinite)

2. **Password handling**:
   ```bash
   # Check password hashing
   grep -rn "password\|hash\|bcrypt\|argon\|scrypt\|pbkdf" server/ --include="*.ts"
   ```
   - Verify: Passwords hashed with bcrypt/argon2/scrypt (not MD5/SHA)
   - Verify: Salt is used (bcrypt auto-salts)
   - Verify: No plaintext passwords in logs, responses, or error messages

3. **Auth middleware coverage**:
   ```bash
   # Find all route files
   find server/routes/ -name "*.ts" -type f
   
   # For each, check requireAuth middleware is applied
   grep -rn "router\.\(get\|post\|put\|patch\|delete\)" server/routes/ --include="*.ts" -A1 | grep -v requireAuth
   ```
   - Verify: All non-public routes require authentication
   - Verify: Role-based checks exist where needed (admin routes)

4. **Token/reset security**:
   ```bash
   grep -rn "token\|resetToken\|passwordReset" server/ --include="*.ts"
   ```
   - Verify: Tokens are cryptographically random (crypto.randomBytes, not Math.random)
   - Verify: Tokens expire after reasonable time
   - Verify: Tokens are single-use (invalidated after use)

5. **Rate limiting on sensitive endpoints**:
   ```bash
   # Check for rate limiting middleware
   grep -rn "rateLimit\|rateLimiter\|throttle\|limiter" server/ --include="*.ts"
   
   # Check login endpoint specifically
   grep -rn "login\|signin\|authenticate" server/routes/ --include="*.ts" -B5 -A5
   
   # Check password reset endpoint
   grep -rn "reset.*password\|forgot.*password\|passwordReset" server/routes/ --include="*.ts" -B5 -A5
   ```
   - Verify: Login endpoint has rate limiting (prevent brute force)
   - Verify: Password reset endpoint has rate limiting (prevent enumeration)
   - Verify: API endpoints with expensive operations have rate limiting
   - Recommended limits: Login: 5 attempts per 15 minutes per IP, Password reset: 3 per hour per email

5. **Process-level crash resilience**:
   ```bash
   # Check that uncaughtException/unhandledRejection handlers are in place
   grep -rn "uncaughtException\|unhandledRejection\|isNeonDriverBug" server/index.ts
   ```
   - Verify: `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers exist in `server/index.ts`
   - Verify: `isNeonDriverBug()` function filters known Neon WebSocket driver errors (`TypeError: Cannot set property message of #<ErrorEvent>`)
   - Verify: Non-Neon uncaught exceptions still log and exit (don't silently swallow real crashes)
   - **Known attack surface**: If these handlers are removed, any DB connection timeout via the Neon WebSocket driver will crash the server, creating a denial-of-service vector

### Red Flags:
- Plaintext password in any variable, log, or response → FAIL
- Missing httpOnly/secure on session cookies → FAIL
- Route without auth middleware that accesses user data → FAIL
- Token generated with Math.random → FAIL
- Password reset token without expiry → FAIL
- Missing `uncaughtException`/`unhandledRejection` handlers → FAIL (server crash on DB timeout)
- `isNeonDriverBug()` suppression removed → FAIL (DB timeouts crash server)
- Session without expiry → WARN
- No rate limiting on login endpoint → WARN
- No rate limiting on password reset → WARN

---

## Category 2: CSRF Protection

**Goal**: All state-changing requests are protected against Cross-Site Request Forgery.

### Steps:
1. **CSRF middleware check**:
   ```bash
   # Find CSRF implementation
   grep -rn "csrf\|CSRF\|csrfToken\|_csrf\|double.submit\|x-csrf" server/ --include="*.ts"
   ```
   - Verify: CSRF protection exists (token or double-submit cookie pattern)
   - Verify: Applied to all POST/PUT/PATCH/DELETE routes

2. **Frontend CSRF compliance**:
   ```bash
   # Check that frontend mutations use API client (not direct fetch)
   grep -rn "fetch(" client/src/ --include="*.ts" --include="*.tsx" | grep -v "GET\|node_modules\|\.d\.ts"
   ```
   - Verify: All mutations go through the central API client
   - Verify: API client sends CSRF token with every mutation

3. **CSRF bypass paths**:
   ```bash
   # Check for routes that skip CSRF
   grep -rn "csrf.*skip\|csrf.*exclude\|no.*csrf" server/ --include="*.ts" -i
   ```
   - Any CSRF bypass must be justified and documented

### Red Flags:
- State-changing endpoint without CSRF protection → FAIL
- Frontend mutation using direct fetch() → FAIL
- CSRF token predictable or static → FAIL

---

## Category 3: Input Validation & Injection Prevention

**Goal**: All user input is validated, sanitized, and parameterized.

### Steps:
1. **Zod validation coverage**:
   ```bash
   # Find all POST/PUT/PATCH route handlers
   grep -rn "router\.\(post\|put\|patch\)" server/routes/ --include="*.ts" -A5
   ```
   - Verify: Request body is validated with Zod schema before processing
   - Verify: Validated data is used (not raw `req.body`)

2. **SQL injection check**:
   ```bash
   # Check for raw SQL with string interpolation
   grep -rn "sql\`" server/ --include="*.ts" | grep -v "drizzle"
   grep -rn "query(" server/ --include="*.ts" | grep "\${"
   grep -rn "raw\|rawQuery\|execute" server/ --include="*.ts"
   ```
   - Verify: All queries use Drizzle ORM (parameterized)
   - Verify: No raw SQL with template literal interpolation

3. **XSS prevention**:
   ```bash
   # Check for dangerouslySetInnerHTML
   grep -rn "dangerouslySetInnerHTML\|innerHTML\|__html" client/src/ --include="*.tsx" --include="*.ts"
   ```
   - Verify: No unescaped user input rendered as HTML
   - React auto-escapes by default, but `dangerouslySetInnerHTML` bypasses this

4. **Path traversal**:
   ```bash
   # Check for file operations with user input
   grep -rn "readFile\|writeFile\|createReadStream\|path\.join\|path\.resolve" server/ --include="*.ts"
   ```
   - Verify: File paths are not constructed from user input
   - If they are, verify path traversal prevention (no `../`)

5. **URL parameter validation**:
   ```bash
   # Check for parseInt/parseFloat on URL params without validation
   grep -rn "req\.params\.\|req\.query\." server/routes/ --include="*.ts"
   ```
   - Verify: URL parameters are validated (type, range, format)
   - Verify: `parseInt` results are checked for `NaN`

### Red Flags:
- Route handler using `req.body` without Zod validation → FAIL
- Raw SQL with string concatenation/interpolation → FAIL
- `dangerouslySetInnerHTML` with user-provided content → FAIL
- File path from user input without sanitization → FAIL
- `parseInt(req.params.id)` without NaN check → WARN

---

## Category 4: Secret & Credential Safety

**Goal**: No secrets, API keys, passwords, or tokens are exposed in code, logs, or responses.

### Steps:
1. **Hardcoded secrets**:
   ```bash
   # Check for potential hardcoded secrets
   grep -rn "password\s*=\s*['\"]" server/ client/src/ shared/ --include="*.ts" --include="*.tsx" -i
   grep -rn "apiKey\s*=\s*['\"]" server/ client/src/ shared/ --include="*.ts" --include="*.tsx" -i
   grep -rn "secret\s*=\s*['\"]" server/ client/src/ shared/ --include="*.ts" --include="*.tsx" -i
   grep -rn "token\s*=\s*['\"][a-zA-Z0-9]" server/ client/src/ shared/ --include="*.ts" --include="*.tsx"
   ```
   - Exclude: Test data, schema field names, UI labels

2. **Logging of sensitive data**:
   ```bash
   # Check what's being logged
   grep -rn "console\.log\|console\.error\|console\.warn\|logger\." server/ --include="*.ts" | grep -i "password\|token\|secret\|key\|cookie\|session"
   ```
   - Verify: No passwords, tokens, or secrets in log output

3. **Error response exposure**:
   ```bash
   # Check error handlers for stack trace exposure
   grep -rn "stack\|stackTrace\|error\.message" server/ --include="*.ts" | grep -i "res\.\|response\."
   ```
   - Verify: Production errors don't expose stack traces or internal details
   - Verify: Error messages are user-friendly (German), not technical dumps

4. **Environment variable usage**:
   ```bash
   # Check process.env usage
   grep -rn "process\.env\." server/ shared/ --include="*.ts"
   ```
   - Verify: All secrets come from environment variables
   - Verify: No fallback to hardcoded values for secrets

### Red Flags:
- Hardcoded password/API key/secret in source code → FAIL
- Password or token in console.log → FAIL
- Stack trace in API error response → FAIL
- Secret with hardcoded fallback value → FAIL
- Environment variable accessed in client-side code → FAIL

---

## Category 5: Authorization & Access Control

**Goal**: Users can only access data they're authorized to see. Role-based restrictions are enforced at query level.

### Steps:
1. **Role-based route protection**:
   ```bash
   # Find admin-only routes
   grep -rn "admin\|isAdmin\|role\|requireAdmin" server/routes/ server/middleware/ --include="*.ts"
   ```
   - Verify: Admin routes check role, not just authentication
   - Verify: Role check is in middleware, not ad-hoc in each handler

2. **Data-level access control**:
   ```bash
   # Check storage queries for user-scoping
   grep -rn "userId\|user\.id\|req\.user" server/storage/ server/routes/ --include="*.ts"
   ```
   - Verify: Non-admin users can only see their own data
   - Verify: SQL queries include user ID filter (not just API-level checks)
   - Verify: "resource belongs to user" check before update/delete

3. **IDOR (Insecure Direct Object Reference)**:
   ```bash
   # Find routes that access resources by ID
   grep -rn "req\.params\.id\|req\.params\.\w*Id" server/routes/ --include="*.ts"
   ```
   - Verify: Each resource access verifies the user has permission
   - Verify: Can't access another user's data by guessing IDs

### Red Flags:
- Admin route without role check → FAIL
- Storage query without user scoping for multi-user data → FAIL
- Resource accessed by ID without ownership check → FAIL
- Role check only in frontend (not backend) → FAIL

---

## Category 6: Dependency & Supply Chain Security

**Goal**: No known vulnerabilities in npm dependencies. No malicious packages.

### Steps:
1. **Audit dependencies**:
   ```bash
   npm audit --production 2>&1
   ```
2. **Check for outdated critical packages**:
   ```bash
   npm outdated 2>/dev/null | head -20
   ```
3. **Review package.json for suspicious packages**:
   ```bash
   # Count total dependencies
   cat package.json | grep -c "\":" | head -1
   
   # Check for known problematic packages
   grep -i "event-stream\|ua-parser\|colors\|faker" package.json
   ```

4. **Lock file integrity**:
   ```bash
   # Verify lock file exists and is consistent
   ls -la package-lock.json 2>/dev/null || echo "No lock file!"
   
   # Check for integrity hashes in lock file
   grep -c "integrity" package-lock.json 2>/dev/null || echo "No integrity hashes"
   ```
   - Verify: Lock file exists and is committed to git
   - Verify: Lock file has integrity hashes (sha512)

5. **Postinstall script safety**:
   ```bash
   # Check for packages with postinstall scripts
   grep -rn "postinstall\|preinstall\|install" node_modules/*/package.json 2>/dev/null | grep -v "node_modules/.*node_modules" | head -10
   ```
   - Review: Any package running scripts at install time could execute arbitrary code
   - Verify: Known packages only (not typosquatting or unknown packages)

6. **Typosquatting check**:
   - Review: Package names in package.json for potential typosquats of popular packages
   - Example: `expres` instead of `express`, `lodasch` instead of `lodash`

### Red Flags:
- Critical/high severity npm audit findings → FAIL
- Severely outdated security-critical packages (express, bcrypt) → WARN
- Excessive number of dependencies (>100 direct) → WARN
- Missing lock file → FAIL
- Package with suspicious postinstall script → FAIL
- Potential typosquatting package name → FAIL

---

## Category 7: Data Protection (DSGVO/GDPR Specifics)

**Goal**: Personal data is handled according to GDPR requirements.

### Steps:
1. **Data minimization**:
   ```bash
   # Check API responses for unnecessary personal data
   grep -rn "password\|passwordHash\|token" server/routes/ --include="*.ts" | grep -i "res\.\|json("
   ```
   - Verify: Passwords and tokens are never returned in API responses
   - Verify: Only necessary fields are included in responses

2. **Soft-delete compliance**:
   ```bash
   grep -rn "DELETE\|\.delete\|remove\|destroy" server/storage/ server/routes/ --include="*.ts" -i
   ```
   - Verify: Personal data uses soft-delete (not hard delete)
   - Verify: Soft-deleted records are filtered from normal queries

3. **Audit trail**:
   ```bash
   grep -rn "createdBy\|updatedBy\|created_by\|updated_by" server/ shared/ --include="*.ts"
   ```
   - Verify: Changes to personal data are tracked (who changed what, when)

### Red Flags:
- Password hash returned in API response → FAIL
- Hard delete on table with personal data → FAIL
- No audit trail for personal data changes → WARN

---

## Category 8: API-Specific Security (OWASP API Top 10)

**Goal**: API endpoints are protected against the most common API-specific attack vectors.

### Steps:
1. **API1:2023 — Broken Object Level Authorization (BOLA)**:
   ```bash
   # Find all endpoints that access resources by ID
   grep -rn "req\.params\.\|/:id\|/:.*Id" server/routes/ --include="*.ts"
   ```
   - Verify: Every resource access checks that the requesting user has permission
   - Verify: Non-admin users can't access other users' resources by changing the ID

2. **API2:2023 — Broken Authentication**:
   - Verify: Authentication tokens/sessions can't be reused after logout
   - Verify: Password complexity is enforced
   - Verify: Account lockout or rate limiting after failed attempts

3. **API3:2023 — Broken Object Property Level Authorization**:
   ```bash
   # Check for mass assignment vulnerabilities
   grep -rn "\.set(req\.body)\|\.set(data)\|spread.*req\.body\|\.\.\.req\.body" server/routes/ --include="*.ts"
   ```
   - Verify: API doesn't blindly accept all fields from request body
   - Verify: Zod schemas explicitly define allowed fields (no passthrough)
   - Verify: Sensitive fields (isAdmin, role, id) can't be set via API

4. **API4:2023 — Unrestricted Resource Consumption**:
   ```bash
   # Check for endpoints that could consume excessive resources
   grep -rn "\.findMany\|\.select()\|getAll\|findAll" server/storage/ --include="*.ts" | grep -v "limit\|take\|paginate"
   ```
   - Verify: List endpoints have pagination or limits
   - Verify: File upload endpoints have size limits
   - Verify: No endpoint allows unbounded queries

5. **API5:2023 — Broken Function Level Authorization**:
   ```bash
   # Check admin-only operations are properly protected
   grep -rn "router\.\(post\|put\|patch\|delete\)" server/routes/ --include="*.ts" -B3 | grep -v "requireAuth\|requireAdmin\|isAdmin\|requireRoles"
   ```
   - Verify: Destructive operations (delete, admin actions) require admin role
   - Verify: No admin function accessible to regular users

6. **API6:2023 — Unrestricted Access to Sensitive Business Flows**:
   - Verify: Critical business operations have confirmation steps
   - Verify: Budget operations have idempotency protection (no double-booking)
   - Verify: Signature operations are irreversible (properly locked)

7. **Excessive Data Exposure**:
   ```bash
   # Check for endpoints that return more data than needed
   grep -rn "SELECT \*\|select()\." server/storage/ --include="*.ts" | head -10
   ```
   - Verify: API responses don't include internal fields (created_by_user_id, password hashes)
   - Verify: Admin-only data isn't exposed to regular users

8. **Content Security Policy (CSP)**:
   ```bash
   # Check for CSP headers
   grep -rn "Content-Security-Policy\|helmet\|csp\|CSP" server/ --include="*.ts"
   ```
   - Verify: CSP headers are set in production
   - Verify: `script-src` restricts inline scripts
   - Verify: `frame-ancestors` prevents clickjacking

### Red Flags:
- Resource accessible by changing ID without permission check → FAIL (BOLA)
- `...req.body` spread into database update → FAIL (Mass Assignment)
- Admin endpoint without role check → FAIL (Broken Function Auth)
- List endpoint without pagination → WARN (Resource Consumption)
- No CSP headers → WARN
- Sensitive fields (isAdmin, role) settable via API → FAIL
- Budget operation without idempotency check → WARN

---

## Output Format

```
## Security Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Auth & Sessions | PASS/WARN/FAIL | Details |
| 2. CSRF Protection | PASS/WARN/FAIL | Details |
| 3. Input Validation | PASS/WARN/FAIL | Details |
| 4. Secret Safety | PASS/WARN/FAIL | Details |
| 5. Access Control | PASS/WARN/FAIL | Details |
| 6. Dependencies & Supply Chain | PASS/WARN/FAIL | Details |
| 7. Data Protection (DSGVO) | PASS/WARN/FAIL | Details |
| 8. API Security (OWASP API Top 10) | PASS/WARN/FAIL | Details |

### Critical Findings (must fix immediately)
- [List any FAIL items]

### Recommendations (should fix)
- [List any WARN items]

### Commands Executed
[List exact commands run and key results]
```
