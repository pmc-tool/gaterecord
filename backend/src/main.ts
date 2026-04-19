// Polyfill for crypto.randomUUID in Node.js < 19
import * as cryptoNode from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  (globalThis as unknown as { crypto: typeof cryptoNode }).crypto = cryptoNode;
}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Enable raw body for Stripe webhook signature verification
    rawBody: true,
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // CORS
  const defaultOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://192.168.88.8:5173',
    'http://192.168.88.8:5174',
    'https://gaterecord.com',
    'https://www.gaterecord.com',
    'https://dev.gaterecord.com',
    'https://www.dev.gaterecord.com',

  ];

  app.enableCors({
    origin: defaultOrigins,
    credentials: true,
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger docs available at: http://localhost:${port}/api/docs`);
}
bootstrap();
