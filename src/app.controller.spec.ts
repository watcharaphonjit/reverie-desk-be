import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: PrismaService,
          useValue: { $queryRaw: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('health endpoint returns ok', async () => {
    await expect(appController.health()).resolves.toEqual({
      status: 'ok',
      db: 'connected',
    });
  });
});
