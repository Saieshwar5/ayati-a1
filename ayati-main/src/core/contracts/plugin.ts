export interface AyatiPlugin {
  name: string;
  version: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
