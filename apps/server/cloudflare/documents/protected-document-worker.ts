import mupdf from "mupdf";

const fetch = (request: Request): Promise<Response> =>
  request.arrayBuffer().then((bytes) => {
    const document = mupdf.Document.openDocument(bytes, "application/pdf");
    try {
      return Response.json({ requiresPassword: document.needsPassword() });
    } finally {
      document.destroy();
    }
  });

/**
 * Non-routable startup probe for MuPDF's Worker compatibility. If startup succeeds, `POST` opens the
 * supplied PDF in memory and reports only whether it needs a password. The build gate currently
 * requires startup to fail before this unbounded probe can receive a request.
 */
export default { fetch };
