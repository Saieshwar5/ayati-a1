import { main } from "./app/main.js";

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
