// ログ本体の保存先をこのインターフェースの背後に隠す。
// 将来ローカルディスク/S3実装に差し替えられるようにインターフェースで分離。
export interface LogStorage {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export class R2LogStorage implements LogStorage {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body);
  }

  async get(key: string): Promise<string | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return obj.text();
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
