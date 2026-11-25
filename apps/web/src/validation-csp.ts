import { z } from "zod";
// Run before schema modules: Zod's optional JIT probes new Function, which CSP forbids.
z.config({ jitless: true });
