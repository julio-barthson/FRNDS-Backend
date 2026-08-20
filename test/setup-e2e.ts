import 'dotenv/config';

// The e2e suite boots the real module graph, which refuses to start without
// signing secrets. Fall back to throwaway values so the tests run on a clean
// checkout and in CI, where no .env exists.
process.env.JWT_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/test';
process.env.NODE_ENV = 'test';
