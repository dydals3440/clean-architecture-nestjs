import { ConfigService } from '@nestjs/config';
import { Db, MongoClient } from 'mongodb';

export const MONGO_DB = Symbol('MONGO_DB');

export const MongoProvider = {
  provide: MONGO_DB,
  inject: [ConfigService],
  useFactory: async (configService: ConfigService): Promise<Db> => {
    const uri = configService.getOrThrow<string>('MONGO_URI');
    const dbName = configService.get<string>(
      'MONGO_DB_NAME',
      'clean-architecture',
    );

    const client = new MongoClient(uri);

    await client.connect();
    return client.db(dbName);
  },
};
