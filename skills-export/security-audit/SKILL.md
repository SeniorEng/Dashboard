---
name: security-audit
description: Dedicated security audit agent that checks for OWASP vulnerabilities, secret exposure, authentication bypass, CSRF protection, input validation, and dependency security. Use after ANY code change that touches authentication, API routes, user input handling, or external dependencies. More thorough than database-audit Category 10 — this is the dedicated security specialist.
---

# Security Audit Agent

This agent performs deep security analysis following OWASP guidelines and security best practices. It goes beyond the basic security checks in database-audit Category 10 to provide comprehensive vulnerability detection.

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

### Red Flags:
- Plaintext password in any variable, log, or response → FAIL
- Missing httpOnly/secure on session cookies → FAIL
- Route without auth middleware that accesses user data → FAIL
- Token generated with Math.random → FAIL
- Password reset token without expiry → FAIL
- Session without expiry → WARN

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

## Category 6: Dependency Security

**Goal**: No known vulnerabilities in npm dependencies.

### Steps:
1. **Audit dependencies**:
   ```bash
   npm audit --production 2>/dev/null || echo "npm audit not available"
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

### Red Flags:
- Critical/high severity npm audit findings → FAIL
- Severely outdated security-critical packages (express, bcrypt) → WARN
- Excessive number of dependencies (>100 direct) → WARN

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
| 6. Dependencies | PASS/WARN/FAIL | Details |
| 7. Data Protection | PASS/WARN/FAIL | Details |

### Critical Findings (must fix immediately)
- [List any FAIL items]

### Recommendations (should fix)
- [List any WARN items]

### Commands Executed
[List exact commands run and key results]
```
