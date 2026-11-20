export type AnonymousAdmissionRequest = Readonly<{
  request: Request;
  browserOrigin: string;
  admissionKey: string;
}>;
