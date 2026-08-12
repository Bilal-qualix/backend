import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FilesModule } from './files/files.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [FilesModule, PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
