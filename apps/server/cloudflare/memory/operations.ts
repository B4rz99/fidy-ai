import { prepareMemory, readMemories as readLocal } from "./internal/local-memory";

export const prepareLocalMemory: typeof prepareMemory = (...input) => prepareMemory(...input);

export const readLocalMemories: typeof readLocal = (user) => readLocal(user);
