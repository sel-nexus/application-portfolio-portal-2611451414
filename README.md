# Application Portfolio Portal

Identity slice: internal sign-in at `/`, signed-in shell and `/profile`. No signup or unfinished feature pages are exposed. Dashboard and Applications preferences are stored using their final contract; until those slices are added, successful sign-in and password change open the implemented My Profile route.

## Local development

Use Python 3.12+, Node 22+, and MongoDB 8. MongoDB must be running at `mongodb://127.0.0.1:27017`; the URI and database name are separate settings. No in-memory datastore is used.

1. Create a fresh environment: `python3 -m venv --copies "$HOME/venvs/app"`.
2. Install: `"$HOME/venvs/app/bin/pip" install -r backend/requirements.txt` and `cd frontend && npm install`.
3. Copy `backend/.env.example` to `backend/.env`. Replace `JWT_SECRET` with output from `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`. Public/default signing keys are refused at startup.
4. From backend: `"$HOME/venvs/app/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8000`.
5. From frontend: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173`. The default proxy points at the API; configure `API_PROXY_TARGET` in frontend `.env` when needed. `VITE_API_BASE_URL` is a browser URL prefix (default same-origin); never set the development backend hostname there.

Startup creates indexes and inserts only missing seed records. It never resets edited records, roles, passwords, or preferences. The baseline has six roles/users, three Active portfolios, ten applications and prior sign-in audit history. Disable demo seeding with `SEED_ON_STARTUP=false` outside demo deployments. Do not expose the demo database publicly.

## Public demo starting credentials

All six start with **PortalDemo123!**:

| Role | Email |
|---|---|
| Administrator | admin@portfolio.local |
| Executive | executive@portfolio.local |
| Portfolio Leader | leader@portfolio.local |
| Engineer | engineer@portfolio.local |
| Auditor | auditor@portfolio.local |
| Read Only | readonly@portfolio.local |

Administrator must change this password on first sign-in. Password changes revoke all old sessions and issue a replacement bearer. Passwords must be nonempty and no more than 72 UTF-8 bytes; no additional complexity policy is invented.

## Contracts and extension interfaces

Business endpoints use `/api/v1` without trailing slashes. POST `/auth/login` receives `{email,password}` and returns `{token,user}`. GET `/auth/me` returns current public user. POST `/auth/logout` returns 204. PUT `/profile` receives `{defaultLanding}`. POST `/profile/password` receives `{currentPassword,newPassword,confirmation}` and returns replacement `{token,user}`. GET `/api/health` is public liveness. Responses are `no-store`.

Backend exports `create_app(Settings)`, `get_database`, `get_current_user`, `require_permission`, `allowed_portfolios`, `IdentityRepository`, `AuditRepository` and `IdentityService`. Identity dependencies return `{user,role,session}` with fresh Mongo documents; later services must call `require_permission` and constrain queries using `allowed_portfolios` (None means unrestricted; an empty leader list means no access). Credential version and persisted sessions enforce expiry/revocation/status immediately. Never return raw account documents.

Frontend exports `api<T>`, `ApiError`, `TOKEN_KEY`, `SESSION_EXPIRED`, `useAuth`, `AuthProvider`, `useResource<T>`, `Field`, `DataTable<T>`, `ConfirmDialog`, `Shell` and the public types. `App` owns the single BrowserRouter. Add only completed routes and matching navigation. AuthContext replaces tokens after password change and clears state on protected 401.

## Verification

Tests are authored for the parent developer to execute. Backend uses isolated, uniquely named real Mongo databases, removing only each test database on teardown:

- `cd backend && PYTHONPATH=. "$HOME/venvs/app/bin/python" -m pytest -q tests/test_identity.py`
- `cd frontend && node node_modules/vitest/vitest.mjs run src/features/identity/identity.test.tsx`
- `cd frontend && npm run build`
- `"$HOME/venvs/app/bin/python" -m compileall -q backend/app`

Playwright identity journeys are written now, not executed in this slice. They require a dedicated disposable Mongo database (`E2E_MONGODB_DB=portal_e2e`), generated `E2E_JWT_SECRET`, and initial demo credentials. Do not point browser tests at production. The administrator journey changes and restores its public password; the forced-change assertion requires a fresh baseline. Run later from frontend: `node node_modules/@playwright/test/cli.js test`.

## Containers

Export a generated `JWT_SECRET`, then `docker compose up --build -d`. The frontend listens on `PORTAL_PORT` (default 8080); nginx provides history fallback and service-name API proxy. Mongo has a named persistent volume and no exposed host port. Compose variables: `JWT_SECRET` (required), `MONGODB_DB`, `CORS_ORIGINS`, `SEED_ON_STARTUP`, `PORTAL_PORT`. Deployment must terminate HTTPS at a trusted reverse proxy/CDN. AWS deployment and compose execution are not verified by this slice.
