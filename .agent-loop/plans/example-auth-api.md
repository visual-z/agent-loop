# Example Plan: Build User Authentication API

## TL;DR
> Build a complete JWT-based authentication system with user registration, login, token refresh, and password reset. 4 tasks, sequential execution. ~2 hours estimated.

## Context
### Original Request
Build a user authentication system with JWT tokens for the Express API.

### Research
- Project uses Express 5 + TypeScript
- Database: PostgreSQL with Drizzle ORM
- Existing user table: `users(id, email, name, created_at)`
- No existing auth — greenfield implementation

## Work Objectives
### Core Objective
Implement secure JWT authentication with refresh token rotation.

### Concrete Deliverables
- POST /auth/register — Create new user account
- POST /auth/login — Authenticate and return tokens
- POST /auth/refresh — Rotate refresh token
- POST /auth/forgot-password — Send password reset email
- Auth middleware for protected routes

### Definition of Done
- All endpoints return proper HTTP status codes
- Passwords hashed with bcrypt (cost 12)
- JWT access tokens expire in 15 minutes
- Refresh tokens expire in 7 days
- All tests pass
- No TypeScript errors

### Must Have
- Input validation on all endpoints
- Rate limiting on auth endpoints
- Proper error responses: `{ error: { code, message } }`

### Must NOT Have
- OAuth / social login (future work)
- Email sending (mock it for now)
- Admin endpoints

## Verification Strategy
### Test Decision
Unit tests for each endpoint + integration tests for token flow.

### QA Policy
Every endpoint must have at least 2 test cases (happy path + error).

## TODOs

- [ ] 1. Set up auth infrastructure
  **What to do**: Add bcrypt and jsonwebtoken dependencies. Create `src/auth/` directory structure. Add password_hash column to users table via migration. Create JWT utility module with sign/verify functions.
  **Must NOT do**: Don't implement any routes yet — just the foundation.
  **References**: `src/db/schema.ts` for existing schema, `drizzle.config.ts` for migration setup.
  **Acceptance Criteria**: Migration runs cleanly. JWT utility can sign and verify tokens. TypeScript compiles.
  **QA Scenarios (MANDATORY)**: Verify migration adds column. Verify JWT sign → verify roundtrip.

- [ ] 2. Implement registration and login endpoints
  **What to do**: Create POST /auth/register (validate input, hash password, create user, return tokens). Create POST /auth/login (validate credentials, return tokens). Add Zod schemas for validation.
  **Must NOT do**: Don't implement refresh or password reset yet.
  **References**: `src/routes/` for existing route patterns, `src/validators/` for existing Zod schemas.
  **Acceptance Criteria**: Registration creates user with hashed password. Login returns access + refresh tokens. Invalid input returns 400. Wrong password returns 401.
  **QA Scenarios (MANDATORY)**: Register new user → success. Register duplicate email → 409. Login valid → tokens. Login invalid → 401.
  **Depends on**: todo:1

- [ ] 3. Implement token refresh and auth middleware
  **What to do**: Create POST /auth/refresh (validate refresh token, rotate tokens). Create auth middleware that validates JWT and attaches user to request. Apply middleware to a test protected route GET /auth/me.
  **Must NOT do**: Don't implement password reset yet.
  **References**: Existing middleware pattern in `src/middleware/`.
  **Acceptance Criteria**: Refresh endpoint rotates tokens correctly. Auth middleware rejects expired/invalid tokens. GET /auth/me returns current user.
  **QA Scenarios (MANDATORY)**: Refresh with valid token → new tokens. Refresh with expired token → 401. Protected route without token → 401. Protected route with valid token → user data.
  **Depends on**: todo:2

- [ ] 4. Implement password reset flow
  **What to do**: Create POST /auth/forgot-password (generate reset token, mock email sending). Create POST /auth/reset-password (validate reset token, update password). Add rate limiting to all auth endpoints.
  **Must NOT do**: Don't actually send emails — log to console.
  **References**: Rate limiting can use `express-rate-limit` package.
  **Acceptance Criteria**: Reset token generated and logged. Password updated with valid reset token. Rate limiting blocks excessive requests.
  **QA Scenarios (MANDATORY)**: Request reset → token logged. Reset with valid token → password changed. Reset with expired token → 400. Rate limit triggered after 5 requests.
  **Depends on**: todo:3
