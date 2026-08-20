import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Boots the real module graph with the database stubbed out, so this runs
 * anywhere. It covers the wiring that is easy to break and hard to notice:
 * the global auth guard, the /api prefix, and request validation.
 */
describe('App (e2e)', () => {
  let app: INestApplication<App>;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        user: { findUnique: jest.fn(), findFirst: jest.fn() },
        session: { findUnique: jest.fn() },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the health check without a token', () => {
    return request(server())
      .get('/api/health')
      .expect(200)
      .expect((res) => {
        expect((res.body as { status: string }).status).toBe('ok');
      });
  });

  it('rejects an unauthenticated request to a protected route', () => {
    return request(server()).get('/api/auth/me').expect(401);
  });

  it('rejects registration with an invalid payload', () => {
    return request(server())
      .post('/api/auth/register')
      .send({ email: 'not-an-email' })
      .expect(400);
  });
});
