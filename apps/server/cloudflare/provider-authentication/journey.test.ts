import {
  nativeProviderBrowserGuards,
  nativeProviderRefusals,
  nativeProviderRollback,
} from "./native-provider.test-fixture";

nativeProviderBrowserGuards("google");

nativeProviderRefusals("google");

nativeProviderRollback("google");
