/**
 * Creates an administrator.
 *
 * Solves the bootstrap problem: admin accounts are made by other admins, so the
 * very first one has nowhere to come from. Run this once to mint a SUPER_ADMIN,
 * then create the rest through the console.
 *
 *   node scripts/create-admin.cjs you@example.com "Ada Lovelace" SUPER_ADMIN
 *
 * Position defaults to SUPER_ADMIN when omitted. The password is generated here
 * and printed once — it is never stored in plain text and cannot be recovered,
 * only reset. `mustChangePassword` is set, so the console makes them choose
 * their own on first sign-in.
 *
 * Raw SQL over the Neon driver rather than the Prisma client: Prisma 7 emits
 * TypeScript, so a plain `node` script cannot require the generated client
 * without a build step. See scripts/backfill-release-billing.cjs.
 */
const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

require('dotenv').config();

const BCRYPT_ROUNDS = 10;
const POSITIONS = [
  'SUPER_ADMIN',
  'ADMIN',
  'FINANCE',
  'SUPPORT',
  'MODERATOR',
  'VIEWER',
];

/** Readable at a glance and still 96 bits of entropy — it gets typed once. */
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function main() {
  const [email, name, position = 'SUPER_ADMIN'] = process.argv.slice(2);

  if (!email || !name) {
    console.error(
      'Usage: node scripts/create-admin.cjs <email> <name> [position]\n' +
        `Positions: ${POSITIONS.join(', ')}`,
    );
    process.exit(1);
  }

  if (!POSITIONS.includes(position)) {
    console.error(`Unknown position "${position}". One of: ${POSITIONS.join(', ')}`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const sql = neon(connectionString);

  const existing = await sql`
    SELECT u."id", u."role" FROM "User" u WHERE lower(u."email") = lower(${email})
  `;

  const password = generatePassword();
  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let userId;

  if (existing.length > 0) {
    // Promoting an account that already exists rather than refusing. The likely
    // reason for running this twice is that someone signed up first.
    userId = existing[0].id;
    console.log(`Account exists — promoting it to ${position}.`);
    await sql`
      UPDATE "User"
      SET "role" = 'ADMIN',
          "password" = ${hashed},
          "mustChangePassword" = true,
          "emailVerified" = true,
          "updatedAt" = NOW()
      WHERE "id" = ${userId}
    `;
  } else {
    userId = crypto.randomUUID();
    const [firstName, ...rest] = name.trim().split(/\s+/);

    // `emailVerified` is set outright: this account was created by someone with
    // database access, and the verification email exists to prove an address
    // belongs to whoever typed it. There is nothing left to prove.
    await sql`
      INSERT INTO "User" (
        "id", "email", "firstName", "lastName", "role",
        "password", "provider", "emailVerified", "mustChangePassword",
        "onboardingCompleted", "accountStatus", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, ${email.toLowerCase()}, ${firstName}, ${rest.join(' ') || null}, 'ADMIN',
        ${hashed}, 'local', true, true,
        true, 'ACTIVE', NOW(), NOW()
      )
    `;
  }

  await sql`
    INSERT INTO "Admin" ("id", "userId", "position", "modules", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${userId}, ${position}::"AdminPosition", '[]'::jsonb, NOW(), NOW())
    ON CONFLICT ("userId")
    DO UPDATE SET "position" = ${position}::"AdminPosition", "updatedAt" = NOW()
  `;

  console.log('\n  Administrator ready.');
  console.log(`  Email:    ${email}`);
  console.log(`  Position: ${position}`);
  console.log(`  Password: ${password}`);
  console.log('\n  Shown once. They will be asked to change it on first sign-in.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
