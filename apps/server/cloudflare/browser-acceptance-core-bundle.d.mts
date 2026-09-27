// The sibling .mjs is built from core-worker.ts by browser-acceptance-core-module.ts.
// Re-export its source declarations so the fixture can statically type-check the imported module.
export {
  makeCoreWorker,
  UserTransactionCoordinator,
  runBillingCollectionWorkflow,
} from "./core-worker";
