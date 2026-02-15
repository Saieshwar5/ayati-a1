export interface AyatiStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  has(key: string): boolean;
  keys(): string[];
}

class InMemoryStore<T> implements AyatiStore<T> {
  private store = new Map<string, T>();

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  set(key: string, value: T): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}

export function createStore<T>(): AyatiStore<T> {
  return new InMemoryStore<T>();
}
