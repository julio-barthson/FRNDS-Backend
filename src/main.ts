import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Audio and artwork go straight to S3 via presigned URLs, so request bodies
  // stay small — this is JSON metadata only. Configured through Nest rather
  // than by importing express, which is not a direct dependency here.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  app.use(cookieParser());

  // Behind Render's proxy, req.ip is the load balancer without this, which
  // would make per-IP rate limiting useless.
  app.set('trust proxy', 1);

  const port = Number(process.env.PORT ?? 8000);
  const isDev = process.env.NODE_ENV !== 'production';

  const allowedOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // React Native and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (isDev) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} is not allowed`));
    },
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // The mobile app is built against this — keep it reachable in dev, and off
  // in production until there is a reason to expose the surface publicly.
  if (isDev) {
    const config = new DocumentBuilder()
      .setTitle('FRNDSHQ API')
      .setDescription('Artist accounts, catalogue and uploads')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
