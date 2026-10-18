// Standalone start for manual exploration (from the repository root):
//   DATABASE_URL=postgres://… npm run ledger:dev
// Starts the authorization server on :3101 and the Ledger API on :3100 that trusts it.
import { createAuthServer } from '../../auth-server/src/app.ts';
import { buildApp } from './app.ts';
import { createPool, migrate } from './db.ts';

const authPort = Number(process.env.AUTH_PORT ?? 3101);
const auth = await createAuthServer();
auth.setIssuer(`http://localhost:${authPort}`);
await auth.app.listen({ port: authPort, host: '0.0.0.0' });
console.log(`Authorization server on ${auth.issuer}`);

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger');
console.log('migrations applied:', await migrate(pool));
const app = buildApp(pool, {
  issuer: auth.issuer,
  audience: 'ledger-api',
  jwksUrl: `${auth.issuer}/.well-known/jwks.json`,
});
await app.listen({ port: Number(process.env.PORT ?? 3100), host: '0.0.0.0' });
console.log(`Ledger API on http://localhost:${process.env.PORT ?? 3100}`);
