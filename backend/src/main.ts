// Polyfill for crypto.randomUUID in Node.js < 19
import * as cryptoNode from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  (globalThis as unknown as { crypto: typeof cryptoNode }).crypto = cryptoNode;
}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Behind a reverse proxy (nginx, traefik, cloudflare) so req.ip and
  // X-Forwarded-For are resolved correctly.
  app.set('trust proxy', true);

  app.setGlobalPrefix('api/v1');

  // Validation pipe - allow unknown properties (required for Cloud+ controller)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,               // strip properties not in DTO
      forbidNonWhitelisted: false,   // DO NOT reject if extra properties exist
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // CORS
  const defaultOrigins = [
    'http://localhost:5173',
    'http://localhost:5175',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://192.168.88.8:5173',
    'http://192.168.88.8:5174',
    'http://192.168.88.8:5175',
    'https://gaterecord.com',
    'https://www.gaterecord.com',
    'https://dev.gaterecord.com',
    'https://www.dev.gaterecord.com',
  ];

  app.enableCors({
    origin: defaultOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Gate Management API')
    .setDescription('SaaS Gate Management System API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Run onModuleDestroy hooks on SIGINT/SIGTERM. Without this, a `nest start
  // --watch` restart kills the process without cleanup, so the Cloud Plus TCP
  // server never closes its socket and the next start hits EADDRINUSE on 8002.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger docs available at: http://localhost:${port}/api/docs`);
}
bootstrap();
