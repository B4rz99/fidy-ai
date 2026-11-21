import {
  nativeProviderBrowserGuards,
  nativeProviderRefusals,
  nativeProviderRollback,
} from "./native-provider.test-fixture";

nativeProviderBrowserGuards("microsoft");

nativeProviderRefusals("microsoft");

nativeProviderRollback("microsoft");
