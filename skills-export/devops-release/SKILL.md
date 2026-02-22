---
name: devops-release
description: Automated DevOps and release readiness agent that checks environment configuration, dependency health, build integrity, logging, error monitoring, and deployment readiness. Use before publishing, after adding dependencies, or when troubleshooting environment issues. Ensures the app is production-ready and maintainable.
---

# DevOps & Release Manager Agent

This agent validates that the application is production-ready, properly configured, and maintainable. It checks environment variables, dependency health, build process, logging, and deployment readiness.

## When to Run

- Before deployment/publishing (mandatory)
- After adding/removing npm dependencies
- After changing environment variables or secrets
- After modifying build configuration (vite.config.ts, tsconfig.json)
- When troubleshooting startup or build failures
- During periodic maintenance reviews (monthly)

## Core Principle

**If it works on your machine but breaks in production, it's a DevOps failure.** Every configuration, dependency, and environment assumption must be explicit, documented, and validated.

---

## Category 1: Environment & Configuration

**Goal**: All environment variables are properly defined, documented, and available where needed.

### Steps:
1. **Required environment variables**:
   ```bash
   # Find all process.env references
   grep -rn "process\.env\." server/ shared/ --include="*.ts" | sed 's/.*process\.env\.\([A-Z_]*\).*/\1/' | sort -u
   ```
   - Verify: Every referenced env var is either set or has a safe fallback
   - Verify: No env var has a hardcoded secret as fallback

2. **Secret management**:
   ```bash
   # Check for hardcoded secrets
   grep -rn "password.*=.*['\"]" server/ --include="*.ts" -i | grep -v "schema\|type\|interface\|placeholder\|label"
   grep -rn "apiKey\|api_key\|secret.*=.*['\"]" server/ --include="*.ts" -i | grep -v "schema\|type\|const.*name"
   ```
   - Verify: All secrets are in Replit Secrets, not in code
   - Verify: No secrets in client-side code (they'd be in the bundle!)

3. **Environment parity**:
   ```bash
   # Check for dev-only conditions
   grep -rn "NODE_ENV\|development\|production" server/ --include="*.ts"
   ```
   - Verify: Dev/prod differences are intentional and documented
   - Verify: No debug features accidentally enabled in production

4. **Database connection**:
   ```bash
   # Check database connection configuration
   grep -rn "DATABASE_URL\|neon\|postgres\|pool\|connection" server/ --include="*.ts"
   ```
   - Verify: Connection pooling is configured (max connections, idle timeout)
   - Verify: Connection errors are handled gracefully (retry, meaningful error)

### Red Flags:
- Hardcoded secret in source code → FAIL
- Environment variable used but never set → FAIL
- Secret accessible in client-side code → FAIL
- Database connection without pool limits → WARN
- Missing error handling for DB connection failure → WARN

---

## Category 2: Dependency Health

**Goal**: All dependencies are secure, up-to-date, and necessary.

### Steps:
1. **Security audit**:
   ```bash
   npm audit --production 2>&1
   ```
   - Verify: No critical or high severity vulnerabilities
   - Document: Low/moderate vulnerabilities with justification if not fixed

2. **Unused dependencies**:
   ```bash
   # List all dependencies from package.json
   cat package.json | grep -E "\"[a-z@].*\":" | grep -v "scripts\|name\|version\|description" | sed 's/.*"\(.*\)".*/\1/' | head -30
   
   # For each, check if it's actually imported
   # (Sample the largest/most suspicious ones)
   grep -rn "from ['\"]<PACKAGE>['\"]" server/ client/src/ shared/ --include="*.ts" --include="*.tsx"
   ```
   - Verify: Every dependency in package.json is actually used
   - Verify: No duplicate packages providing same functionality

3. **Dependency count**:
   ```bash
   # Count direct dependencies
   cat package.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'dependencies: {len(d.get(\"dependencies\",{}))}, devDependencies: {len(d.get(\"devDependencies\",{}))}')" 2>/dev/null || echo "Count manually"
   ```
   - Verify: Reasonable number of dependencies (< 80 direct for this project)

4. **Lock file consistency**:
   ```bash
   # Check if lock file exists and is committed
   ls -la package-lock.json 2>/dev/null || ls -la yarn.lock 2>/dev/null || echo "No lock file!"
   ```
   - Verify: Lock file exists and is up to date

### Red Flags:
- Critical npm audit finding → FAIL
- High severity npm audit finding → WARN
- Unused dependency in package.json → WARN
- Missing lock file → FAIL
- > 100 direct dependencies → WARN

---

## Category 3: Build & Startup Integrity

**Goal**: The application builds cleanly and starts without errors.

### Steps:
1. **TypeScript compilation**:
   ```bash
   npx tsc --noEmit 2>&1 | tail -20
   ```
   - Verify: No TypeScript errors (warnings are acceptable)
   - Note: Strict mode violations are acceptable if not enabled project-wide

2. **Build process**:
   ```bash
   # Check if build succeeds
   npx vite build 2>&1 | tail -20
   ```
   - Verify: Build completes without errors
   - Note: Bundle size and chunk warnings

3. **Startup checks**:
   ```bash
   # Check for startup-time errors in logs
   grep -rn "listen\|started\|ready\|running" server/ --include="*.ts" | head -5
   ```
   - Verify: Server starts without errors
   - Verify: Database migration/push runs cleanly on startup
   - Verify: Required services are available (DB, storage, etc.)

4. **Build configuration**:
   ```bash
   # Check vite config
   cat vite.config.ts 2>/dev/null || cat vite.config.js 2>/dev/null
   
   # Check TypeScript config
   cat tsconfig.json
   ```
   - Verify: Source maps enabled for production debugging
   - Verify: Build output directory is correct

### Red Flags:
- TypeScript compilation errors → FAIL
- Build fails → FAIL
- Server crashes on startup → FAIL
- Missing database migration on startup → WARN
- Large bundle without code splitting → WARN

---

## Category 4: Logging & Error Monitoring

**Goal**: Errors in production are detectable, diagnosable, and actionable.

### Steps:
1. **Server-side logging**:
   ```bash
   # Find logging statements
   grep -rn "console\.\(log\|error\|warn\|info\)" server/ --include="*.ts" | wc -l
   
   # Check for structured logging
   grep -rn "console\.error" server/ --include="*.ts" | head -10
   ```
   - Verify: Errors are logged with sufficient context (what failed, what input caused it)
   - Verify: No sensitive data in logs (passwords, tokens, personal data)
   - Verify: Log levels are appropriate (error for errors, warn for warnings, info for normal ops)

2. **Unhandled errors**:
   ```bash
   # Check for global error handlers
   grep -rn "uncaughtException\|unhandledRejection\|process\.on" server/ --include="*.ts"
   
   # Check for Express error middleware
   grep -rn "err.*req.*res.*next\|errorMiddleware\|errorHandler" server/ --include="*.ts"
   ```
   - Verify: Global error handlers exist for uncaught exceptions
   - Verify: Express error middleware catches all route errors
   - Verify: Unhandled promise rejections don't crash the server

3. **Client-side error handling**:
   ```bash
   # Check for React error boundaries
   grep -rn "ErrorBoundary\|componentDidCatch\|getDerivedStateFromError" client/src/ --include="*.tsx"
   
   # Check for global error handling
   grep -rn "window\.onerror\|addEventListener.*error\|addEventListener.*unhandledrejection" client/src/ --include="*.ts" --include="*.tsx"
   ```
   - Verify: React error boundaries exist around critical sections
   - Verify: Client-side errors don't show blank white screens

4. **Health checks**:
   ```bash
   # Check for health/status endpoint
   grep -rn "health\|status\|ping\|ready" server/routes/ --include="*.ts" -i
   ```
   - Verify: A health check endpoint exists for monitoring
   - Verify: It checks database connectivity

### Red Flags:
- No error middleware → FAIL
- Sensitive data in console.log → FAIL
- No React error boundary → WARN
- No health check endpoint → WARN
- Console.log with user data in production code → WARN

---

## Category 5: Database Operations & Data Safety

**Goal**: Database operations are safe, migrations are reliable, and data integrity is maintained.

### Steps:
1. **Migration strategy**:
   ```bash
   # Check how schema changes are applied
   grep -rn "db:push\|db:migrate\|drizzle-kit" package.json
   
   # Check for seed/initialization data
   grep -rn "seed\|initialize\|ensureSystem\|bootstrap" server/ --include="*.ts"
   ```
   - Verify: Schema changes use ORM tools (not raw SQL)
   - Verify: Seed data is idempotent (can run multiple times safely)

2. **Backup awareness**:
   - Verify: Database provider handles backups (Neon has point-in-time recovery)
   - Verify: No destructive operations without safeguards
   ```bash
   grep -rn "DROP\|TRUNCATE\|DELETE.*FROM.*WHERE" server/ --include="*.ts" -i
   ```

3. **Transaction usage**:
   ```bash
   # Find multi-table operations
   grep -rn "db\.transaction\|\.transaction(" server/ --include="*.ts"
   
   # Find potential multi-write operations WITHOUT transactions
   grep -rn "await.*update\|await.*insert\|await.*delete" server/storage/ server/routes/ --include="*.ts" -A2 | grep -A2 "await.*update\|await.*insert"
   ```
   - Verify: Multi-table writes use transactions
   - Verify: Transaction errors trigger proper rollback

### Red Flags:
- Destructive SQL without WHERE clause → FAIL
- Multi-table write without transaction → WARN
- Non-idempotent seed data → WARN
- Raw SQL migrations instead of ORM → WARN

---

## Category 6: Pre-Deployment Checklist

**Goal**: The application is ready for production deployment.

### Final Checklist:
1. **Build**:
   - [ ] `npm run build` succeeds without errors
   - [ ] No TypeScript errors in production code
   - [ ] Bundle size is reasonable (< 1MB gzipped total)

2. **Configuration**:
   - [ ] All required environment variables are set
   - [ ] No hardcoded secrets in code
   - [ ] Database connection is configured with pooling
   - [ ] CSRF protection is enabled

3. **Security**:
   - [ ] `npm audit` shows no critical vulnerabilities
   - [ ] Auth middleware covers all private routes
   - [ ] Sessions have expiry configured
   - [ ] Error responses don't leak internal details

4. **Resilience**:
   - [ ] Error middleware handles all server errors
   - [ ] Database connection failures are handled gracefully
   - [ ] Client-side error boundaries prevent white screens

5. **Performance**:
   - [ ] Database queries are paginated where appropriate
   - [ ] Static assets have cache headers
   - [ ] Admin pages are lazy-loaded
   - [ ] No console.log statements in production path (except errors)

6. **Data**:
   - [ ] Database schema is in sync (no pending migrations)
   - [ ] Seed data has been applied
   - [ ] No test/mock data in production database

### Red Flags:
- Any unchecked item from the checklist → WARN or FAIL depending on severity
- Build failure → FAIL (blocks deployment)
- Critical security issue → FAIL (blocks deployment)

---

## Output Format

```
## DevOps & Release Audit Report

| Category | Status | Findings |
|----------|--------|----------|
| 1. Environment & Config | PASS/WARN/FAIL | Details |
| 2. Dependency Health | PASS/WARN/FAIL | Details |
| 3. Build & Startup | PASS/WARN/FAIL | Details |
| 4. Logging & Monitoring | PASS/WARN/FAIL | Details |
| 5. Database Operations | PASS/WARN/FAIL | Details |
| 6. Pre-Deploy Checklist | PASS/WARN/FAIL | Details |

### Deployment Readiness: ✅ READY / ⚠️ READY WITH WARNINGS / ❌ NOT READY

### Action Items
- FAIL items: Must fix before deployment
- WARN items: Should fix, document if deferred

### Environment Summary
- Node.js version: X.X
- Dependencies: X direct, X dev
- npm audit: X vulnerabilities (X critical, X high)
- Bundle size: X KB gzipped
- TypeScript errors: X
```

---

## Cross-References to Other Audit Skills

This audit covers **deployment readiness and operations**. For complete coverage, also run:

| Skill | When to Also Run | What It Adds |
|-------|-----------------|--------------|
| `security-audit` | **ALWAYS** before deployment | OWASP, auth bypass, CSRF, secrets |
| `performance-audit` | Before deployment | Query efficiency, bundle size, mobile speed |
| `code-quality-supervisor` | After any changes | Convention compliance, dead code |
| `database-audit` | When DB changes involved | Schema drift, indexing, data integrity |
