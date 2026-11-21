export type ProviderConfiguration = Readonly<{ BROWSER_ORIGIN: string }> &
  Partial<
    Readonly<{
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      GOOGLE_REDIRECT_URI: string;
      MICROSOFT_CLIENT_ID: string;
      MICROSOFT_CLIENT_SECRET: string;
      MICROSOFT_REDIRECT_URI: string;
    }>
  >;
