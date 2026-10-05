// npm run db:migrate | db:seed | db:reset   (add --eval to target EVAL_DATABASE_URL, --all to also clear the Claude cache)
import { closePools, dbUrl, migrate, resetDb, seed } from '@/server/db';

async function main() {
  const [command] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const url = dbUrl(process.argv.includes('--eval') ? 'eval' : 'dev');
  const label = new URL(url).pathname.slice(1);
  if (command === 'migrate') {
    const applied = await migrate(url);
    console.log(applied.length ? `Applied ${applied.join(', ')} to ${label}` : `${label} is up to date`);
  } else if (command === 'seed') {
    const n = await seed(url);
    console.log(`Seeded ${label}: ${n.parts} parts from the ERP export and ${n.customers} customers`);
  } else if (command === 'reset') {
    await migrate(url);
    await resetDb(url, { all: process.argv.includes('--all') });
    console.log(`Reset ${label}${process.argv.includes('--all') ? ' (including the Claude cache)' : ''}`);
  } else {
    console.error('Usage: tsx scripts/db.ts migrate|seed|reset [--eval] [--all]');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
