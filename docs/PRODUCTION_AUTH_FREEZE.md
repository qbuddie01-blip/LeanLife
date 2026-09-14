# Production Authentication Freeze Manifest

> **PRODUCTION AUTHENTICATION IS FROZEN AFTER REAL-WORLD ACCEPTANCE VERIFICATION.**

> Authentication changes require a new defect report, explicit change authorization, isolated implementation, full regression testing, and renewed real-world acceptance verification before deployment.

---

## 1. Freeze Metadata

| Attribute | Value |
|---|---|
| **Freeze Status** | `FROZEN` |
| **Accepted Production Commit** | `a89a5ec6767e8550b67d9d7050266eb84a27b0f5` (`a89a5ec`) |
| **Git Tag** | `leanlife-auth-verified-fixed` |
| **Baseline Branch** | `production-auth-freeze` |
| **Production Domain** | https://leanlife-community.app |
| **Android / Web Asset Parity** | 100% byte-for-byte SHA-256 match (`d8c33961165a3265b1b058e77352af4d6baf1d47c806e9abe89cca13ec8488c7`, 409,615 bytes) |
| **Verification Date** | September 14, 2026 |
| **Automated Regression Suites** | **16/16 PASSED** |
| **Login Remediation Tests** | **14/14 PASSED** |
| **Real-World Acceptance Verification** | **4/4 SUITES PASSED (100%)** |

---

## 2. Major Verified Authentication Behaviors

1. **Authoritative Server Authentication When Online**
   - `AuthService.authenticate` delegates directly to `authenticateFromRemote` (`/.netlify/functions/auth`).
   - The client-side cache never rejects a valid account due to missing password hash (`password === undefined`).
   - Hardcoded seed-account authentication fallbacks have been completely eliminated.

2. **Android WebView Environment Parity & Dynamic URL Resolution**
   - Running in WebView context under `file:///android_asset/index.html`, `getApiBaseUrl()` resolves requests to authoritative production domain `https://leanlife-community.app`.
   - All authentication endpoints (`auth`, `user-admin`, `cloud-read`, `cloud-sync`) work seamlessly without relative path failures.
   - Android asset `leanlife-android/app/src/main/assets/app.js` and web root `app.js` are cryptographically identical.

3. **Authoritative Password Reset & Cross-Device Lifecycle**
   - Admin and self-service password resets update the Supabase `leanlife_auth_index` securely.
   - Temporary PINs authenticate with `firstLogin: true` flag, reliably triggering the forced password-change modal.
   - Submitting a permanent password updates PBKDF2 credentials in `leanlife_auth_index`, clears `firstLogin`, and permanently invalidates old temporary credentials across all devices.

4. **Robust Error Classification**
   - Distinct, descriptive user feedback for `INVALID_CREDENTIALS`, `MISSING_CREDENTIALS`, `NETWORK_ERROR`, `SERVER_ERROR`, and `SESSION_ERROR`.
   - Network timeouts and server faults are never misrepresented as "Invalid Password".

5. **Cloud Security & Zero-Trust Invariants**
   - Anonymous access to sensitive database tables (`system_settings`, `leanlife_auth_index`) is blocked (HTTP 401).
   - HMAC SHA-256 request signing enforces tenant isolation, member ownership, and role checks.
   - Privacy filtering prevents leakage of sensitive attributes during cloud reads.

---

## 3. Protected Files and Components

The following files and subsystems are strictly **PROTECTED** from arbitrary modification:

### Authentication
- `app.js` (Authentication flow, session creation, credential lifecycle)
- `AuthService.authenticate`
- Remote authentication flow (`authenticateFromRemote`)
- Cache-vs-authoritative authentication behavior
- Login error handling & classification
- Session creation & session persistence
- Logout & session clearing
- First-login handling & forced password-change flow
- PBKDF2 password verification & update flows

### Password Reset
- User password reset flow
- `netlify/functions/user-admin.js`
- `request-password-reset`
- `admin-reset-password`
- Temporary PIN generation & persistence
- `firstLogin: true` enforcement
- Permanent password replacement
- Invalidation of old temporary PINs

### Android
- Android WebView authentication behavior
- `file:///android_asset/index.html` support
- `getApiBaseUrl()` implementation
- Production API routing
- Android/Web asset parity (`leanlife-android/app/src/main/assets/app.js`)

### Serverless Authentication
- `netlify/functions/auth.js`
- `netlify/functions/user-admin.js`
- Authentication API behavior
- Supabase authoritative `leanlife_auth_index` access
- Backend key handling & service-role boundaries
- Authentication timeout behavior (6,000ms threshold)

### Cloud Security
- `netlify/functions/cloud-read.js`
- `netlify/functions/cloud-sync.js`
- HMAC SHA-256 request verification
- Member ownership checks
- Admin/coach role verification
- Supabase Row Level Security (RLS) policies
- Anonymous database lockdown
- Privacy filtering for cloud reads

### Database
- `leanlife_auth_index` schema and records
- Protected `system_settings`
- Migrated authentication records
- PBKDF2 password hash format
- Removal of `tempPasswordRaw`
- Existing database security policies

---

## 4. Absolutely Forbidden Changes

Under this freeze, the following actions are strictly prohibited:

- Refactoring, "simplifying", or "optimizing" authentication without explicit authorization.
- Replacing or bypassing the remote serverless authentication flow.
- Restoring client-authoritative authentication or allowing cached profiles to reject valid credentials.
- Restoring hardcoded seed-account authentication or adding fallback accounts.
- Adding hardcoded production credentials, service role keys, or secrets into source code.
- Altering PBKDF2 parameters (iterations, salt length, digest) or password-hash format.
- Bypassing Supabase authorization, weakening RLS, or enabling anonymous direct database operations.
- Exposing `leanlife_auth_index`, password hashes, or temporary credentials.
- Bypassing HMAC validation, ownership checks, or coach/admin role restrictions.
- Reverting Android API routing to relative paths (`file:///...` context).
- Modifying authentication code merely to improve code style or reduce file size.
- Disabling, bypassing, or weakening Netlify secret scanning or automated security mechanisms.

---

## 5. Procedure Required Before Future Modifications

Any future change to the authentication or security architecture must follow this formal protocol:

1. **Defect Identification & Change Request**:
   - File a specific defect report detailing reproducible symptoms, affected accounts/platforms, and root-cause analysis.
   - Secure explicit stakeholder change authorization before modifying any protected file.
2. **Isolated Branching & Non-Destructive Development**:
   - Branch strictly from `production-auth-freeze` or the verified tag.
   - Do not alter unapproved subsystems or lower cryptographic parameters.
3. **Rigorous Automated Testing**:
   - Execute all 16 regression suites (`scratch/runner.js`).
   - Execute all 14 login remediation test suites (`scratch/test_login_remediation.js`).
4. **Real-World Multi-Platform Acceptance**:
   - Test real clean-session desktop browser environments (Chrome/Edge/Firefox).
   - Test real Android WebView environment running from `file:///android_asset/`.
   - Test cross-device password reset and forced password change lifecycle.
   - Test error classification and offline behavior.
5. **Asset Parity Verification**:
   - Confirm 100% byte-for-byte SHA-256 match between root `app.js` and Android assets.
6. **Static Secret Audit**:
   - Complete zero-exposure secret scan before deployment.
7. **Deployment & Post-Deployment Smoke Test**:
   - Verify deployment HTTP 200, API health, and cloud-read reachability.
