export class TimedCache<T> {
  private value: T | undefined;
  private storedAt = 0;
  private pending: Promise<T> | undefined;

  constructor(private readonly ttlMs: number) {}

  get(load: () => Promise<T>, now = Date.now()): Promise<T> {
    if (this.value !== undefined && now - this.storedAt < this.ttlMs) {
      return Promise.resolve(this.value);
    }
    if (this.pending) return this.pending;

    this.pending = load()
      .then((value) => {
        this.value = value;
        this.storedAt = Date.now();
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
