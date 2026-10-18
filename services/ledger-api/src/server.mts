// Standalone start for manual exploration: DATABASE_URL=postgres://… npm run ledger:dev (from the repository root)
import { buildApp } from './app.ts';
import { createPool, migrate } from './db.ts';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger');
console.log('migrations applied:', await migrate(pool));
const app = buildApp(pool);
await app.listen({ port: Number(process.env.PORT ?? 3100), host: '0.0.0.0' });
console.log(`Ledger API on http://localhost:${process.env.PORT ?? 3100}`);
