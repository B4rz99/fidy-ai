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

export default { fetch };
